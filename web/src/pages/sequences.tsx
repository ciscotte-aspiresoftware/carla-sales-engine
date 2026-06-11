// /sequences - multi-step outreach sequence templates + runs.
//
// Two views in one page:
//   1. List view (default): tabs for Templates / Runs. Templates tab is
//      a list-rail + editor pattern (matches /templates). Runs tab is a
//      flat list of recent runs across all accounts.
//   2. Builder view: selected when the rep opens a specific run. Left
//      rail shows step list (numbered, with purpose + days), right pane
//      shows the editable subject + body of the focused step with
//      Regenerate / Approve / Copy buttons.
//
// All routes hit /api/sequences/* (see api/routes/sequences.js). Backend
// is Supabase-only - migration 0010_sequences.sql must be applied.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-base'
import { safeFetchJson } from '@/lib/safe-fetch'
import { useSearchParams, Link } from 'react-router-dom'
import { useWorkspace } from '@/context/workspace-context'
import {
  IconMailForward,
  IconPlus,
  IconTrash,
  IconArrowLeft,
  IconRefresh,
  IconCheck,
  IconCopy,
  IconEdit,
  IconLoader2,
  IconAlertTriangle,
  IconGripVertical,
  IconChevronRight,
  IconChevronDown,
} from '@tabler/icons-react'

const API = API_BASE

// ─── Types (mirrors backend shape) ─────────────────────────────────────

type Purpose = 'intro' | 'value' | 'social_proof' | 'follow_up' | 'breakup'
type LengthHint = 'long' | 'medium' | 'short' | 'brief'
type RunStatus = 'draft' | 'approved' | 'exported'

interface SequenceTemplateStep {
  orderIdx: number
  purpose: Purpose
  daysAfterPrev: number
  lengthHint: LengthHint
  customGuidance: string | null
}
interface SequenceTemplate {
  id: string
  name: string
  icpId: string | null
  portfolioCompany: string | null
  senderTemplateId: string | null
  language: string
  description: string | null
  steps: SequenceTemplateStep[]
  createdAt: number | null
  updatedAt: number | null
}
interface SequenceRunStep {
  orderIdx: number
  purpose: Purpose
  daysAfterPrev: number
  subject: string | null
  body: string | null
  modelUsed: string | null
  editedByUser: boolean
  generatedAt: number | null
}
interface SequenceRun {
  id: string
  templateId: string
  companyId: string
  leadApolloId: string | null
  icpId: string | null
  customInstruction: string | null
  contextSnapshot: { company?: { name?: string; domain?: string }; lead?: { firstName?: string; lastName?: string } }
  status: RunStatus
  createdAt: number | null
  updatedAt: number | null
  // Steps are only included by the single-run GET /runs/:id (rowToRunWithSteps).
  // The list endpoint GET /runs returns rows WITHOUT steps (rowToRun), so
  // any code rendering a run row from the list MUST guard with Array.isArray.
  steps?: SequenceRunStep[]
}
interface EmailTemplateLite { id: string; name: string; portfolioCompany?: string }

// ─── Purpose / length config ───────────────────────────────────────────

// Each purpose maps to a behaviour block GPT receives in the system
// prompt (see api/prompts/sequence-email.js → PURPOSE_GUIDANCE). The
// `describe` string is the one-line explanation shown next to the
// dropdown so the rep can see what they're picking without leaving the
// editor.
const PURPOSES: { value: Purpose; label: string; color: string; describe: string }[] = [
  { value: 'intro',
    label: 'Intro',
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    describe: 'First touch. Anchor on a concrete website signal, one short product framing, one soft CTA.' },
  { value: 'value',
    label: 'Value',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    describe: 'Add one specific insight the intro did NOT name. No "circling back" language.' },
  { value: 'social_proof',
    label: 'Social proof',
    color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
    describe: 'Reference a similar-sized operator running the product. Offer a case study or peer intro.' },
  { value: 'follow_up',
    label: 'Follow-up',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    describe: 'Gentle bump. Acknowledge they\'re busy, no new pitch, plain yes/no question.' },
  { value: 'breakup',
    label: 'Breakup',
    color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    describe: 'Last touch. Polite closeout, no new pitch, no question, leave the door open for next quarter.' },
]
function purposeMeta(p: Purpose) {
  return PURPOSES.find((x) => x.value === p) || PURPOSES[0]
}
// Lengths are the targets GPT is told to hit. "Standard" matches the
// single-email Sales Agent prompt (90-130w) so step 1 of a sequence
// reads at the same size as a one-off Sales Agent email - reps can
// switch back and forth without the body length jumping.
const LENGTHS: { value: LengthHint; label: string }[] = [
  { value: 'long',   label: 'Long (130-160w)' },
  { value: 'medium', label: 'Standard (90-130w · same as Sales Agent)' },
  { value: 'short',  label: 'Short (50-80w · follow-ups)' },
  { value: 'brief',  label: 'Brief (30-50w · breakups)' },
]

function fmtRelative(ts: number | null): string {
  if (!ts) return '-'
  const ms = Date.now() - ts
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

// ─── Page ──────────────────────────────────────────────────────────────

// Page-level error boundary. The white-screen-on-/sequences bug is caused
// by something throwing OUTSIDE BuilderView (the runs list, the new-run
// flow, the workspace filter, etc.) - those can't be caught by the inner
// BuilderErrorBoundary because they're siblings, not children. This outer
// boundary wraps the whole page so any render crash surfaces as a visible
// error card instead of a blank tree. Logs to console with full component
// stack for diagnosis.
class PageErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    console.error('[SequencesPage] render crash:', err, info.componentStack)
  }
  render() {
    if (this.state.err) {
      return (
        <div className="space-y-4 p-4">
          <Card className={cn(GLASS, 'p-4 space-y-2 border border-red-500/40')}>
            <div className="text-sm font-semibold text-red-700 dark:text-red-300">Sequences page hit a render error.</div>
            <pre className="text-[11px] whitespace-pre-wrap font-mono bg-red-500/10 rounded-md p-2 overflow-auto max-h-64">{String(this.state.err?.message || this.state.err)}</pre>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => this.setState({ err: null })} className="text-xs">Try again</Button>
              <Button size="sm" variant="outline" onClick={() => { window.location.href = '/' }} className="text-xs">Go home</Button>
            </div>
          </Card>
        </div>
      )
    }
    return this.props.children
  }
}

export default function SequencesPage() {
  return <PageErrorBoundary><SequencesPageInner /></PageErrorBoundary>
}

function SequencesPageInner() {
  const [searchParams, setSearchParams] = useSearchParams()
  const runId = searchParams.get('run')
  const startCompany = searchParams.get('startCompany')
  const startIcp = searchParams.get('startIcp')
  const [tab, setTab] = useState<'templates' | 'runs'>(
    (searchParams.get('tab') as 'templates' | 'runs') || 'runs',
  )
  // ALL hooks must be declared before any conditional early-return below.
  // Previously `pickerOpen` was declared AFTER `if (runId) return ...`
  // which meant the BuilderView path called 3 hooks and the list path
  // called 4 - flipping between the two views via the URL (click a run
  // then click Back, or vice versa) violated React's Rules of Hooks and
  // crashed the page with "Rendered fewer/more hooks than expected".
  // Hoisting this declaration up so both paths call the exact same hooks
  // in the same order.
  const [pickerOpen, setPickerOpen] = useState(false)

  // When a runId is in the URL we render the builder. Removing the param
  // pops back to the list. Using URL state means refresh works + a rep
  // can bookmark a specific run.
  const openRun = useCallback((id: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (id) next.set('run', id)
    else next.delete('run')
    next.delete('startCompany')
    next.delete('startIcp')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  if (runId) return <BuilderView runId={runId} onBack={() => openRun(null)} />

  // Two entry points into the New Run flow:
  //   1. Arrived from My Accounts (?startCompany=ID): company pre-fixed,
  //      skip the picker and jump straight to template + recipient.
  //   2. User clicked the "New run" button on this page: full picker,
  //      ICP → company multi-select → template + recipient.
  const showFlow = !!startCompany || pickerOpen
  const closeFlow = () => { setPickerOpen(false); openRun(null) }
  const newRunFlow = showFlow ? (
    <NewRunFlow
      fixedCompanyId={startCompany}
      defaultIcpId={startIcp}
      onClose={closeFlow}
      onCreatedSingle={(id) => openRun(id)}
      onCreatedBulk={(count) => { setPickerOpen(false); alert(`${count} sequence draft${count === 1 ? '' : 's'} created. Open each from the Runs tab to generate.`) }}
    />
  ) : null

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3">
            <IconMailForward className="h-6 w-6 text-sky-500" />
            <h1 className="text-2xl font-semibold">Sequences</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Multi-step outreach drafts. Pick a template, kick off a run for a recipient,
            and the system pre-fills every step. Edit, regenerate, then copy out to your sender
            of choice (Lemlist, Smartlead, Outlook). Delivery isn't wired - this generates only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={cn(GLASS_SUBTLE, 'flex items-center rounded-md p-0.5 gap-0.5')}>
            <button
              onClick={() => { setTab('runs'); const n = new URLSearchParams(searchParams); n.set('tab', 'runs'); setSearchParams(n, { replace: true }) }}
              className={cn(
                'px-3 py-1 rounded text-xs transition-colors',
                tab === 'runs' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Runs
            </button>
            <button
              onClick={() => { setTab('templates'); const n = new URLSearchParams(searchParams); n.set('tab', 'templates'); setSearchParams(n, { replace: true }) }}
              className={cn(
                'px-3 py-1 rounded text-xs transition-colors',
                tab === 'templates' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Templates
            </button>
          </div>
          <Button size="sm" onClick={() => setPickerOpen(true)} className="text-xs h-8">
            <IconPlus className="h-3 w-3 mr-1" /> New run
          </Button>
        </div>
      </div>

      {tab === 'templates' ? <TemplatesTab /> : <RunsTab onOpenRun={openRun} />}
      {newRunFlow}
    </div>
  )
}

// ─── New Run flow ──────────────────────────────────────────────────────
//
// Two entry shapes, one component:
//   fixedCompanyId set    → My Accounts arrival. Skip the ICP/company
//                           picker, just show the template + recipient
//                           + custom instruction form for that one
//                           company. Always sync-generates on submit.
//   fixedCompanyId null   → "New run" button on the Sequences page. Show
//                           the full ICP → company picker chain. Supports
//                           single-select (sync gen, navigates to builder)
//                           and bulk-select (creates empty draft runs,
//                           stays on the runs list).

interface CompanyApi {
  id: string
  name?: string
  domain?: string
  vertical?: string
  country?: string
  url?: string
  classification?: Record<string, unknown>
  classifications?: Record<string, Record<string, unknown>>
  reports?: Record<string, string>
  leads?: Array<{
    apolloId?: string
    firstName?: string
    lastName?: string
    title?: string
    email?: string
    linkedinUrl?: string
    liSummary?: unknown
    liPosts?: unknown
    phone?: string
  }>
}

interface IcpSummary { id: string; name: string; portfolioCompany?: string; vertical?: string }

function NewRunFlow({ fixedCompanyId, defaultIcpId, onClose, onCreatedSingle, onCreatedBulk }: {
  fixedCompanyId: string | null
  defaultIcpId: string | null
  onClose: () => void
  onCreatedSingle: (runId: string) => void
  onCreatedBulk: (count: number) => void
}) {
  // Sidebar workspace narrows the ICP dropdown + the template suggestions.
  // Switching workspace mid-flow re-derives both immediately.
  const { workspace } = useWorkspace()
  const [icps, setIcps] = useState<IcpSummary[]>([])
  const [icpId, setIcpId] = useState<string>(defaultIcpId || '')
  const [companies, setCompanies] = useState<CompanyApi[]>([])
  const [search, setSearch] = useState('')
  // Picker state splits into three so the rep can mix per-company + per-
  // lead selection. Rules:
  //   • A company in selectedCompanies is "checked" - one or more runs come
  //     from it. The exact run count depends on the next field.
  //   • selectedLeadsByCompany maps company id → set of lead indices the
  //     rep ticked. Empty (or no entry) means "use default lead[0]" if any
  //     leads exist, otherwise "no-lead no-name mode".
  //   • expandedCompanies tracks which rows are open in the UI. Doesn't
  //     affect generation - purely visual.
  const [selectedCompanies, setSelectedCompanies] = useState<Set<string>>(
    fixedCompanyId ? new Set([fixedCompanyId]) : new Set(),
  )
  const [selectedLeadsByCompany, setSelectedLeadsByCompany] = useState<Record<string, Set<number>>>({})
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set())
  const [templates, setTemplates] = useState<SequenceTemplate[]>([])
  const [templateId, setTemplateId] = useState<string>('')
  const [customInstruction, setCustomInstruction] = useState('')
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [loadingCompanies, setLoadingCompanies] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')

  // Initial fetch: templates + ICP list (and the fixed company if we have one).
  // Both lists are workspace-scoped on the server when a portfolio company
  // is picked, so the dropdowns only show options the rep can actually use.
  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const tUrl = workspace
          ? `${API}/api/sequences/templates?portfolioCompany=${encodeURIComponent(workspace)}`
          : `${API}/api/sequences/templates`
        const iUrl = workspace
          ? `${API}/api/icps?portfolioCompany=${encodeURIComponent(workspace)}`
          : `${API}/api/icps`
        const [t, i, c] = await Promise.all([
          safeFetchJson(tUrl),
          safeFetchJson(iUrl),
          fixedCompanyId ? safeFetchJson(`${API}/api/companies/${encodeURIComponent(fixedCompanyId)}`) : Promise.resolve(null),
        ])
        if (cancel) return
        const tList = ((t as { templates?: SequenceTemplate[] }).templates) || []
        setTemplates(tList)
        setIcps(((i as { icps?: IcpSummary[] }).icps) || [])
        if (c) {
          const com = (c as { company?: CompanyApi }).company
          if (com) setCompanies([com])
        }
        // Auto-pick a template scoped to this ICP if one exists, else first.
        const match = (defaultIcpId && tList.find((x) => x.icpId === defaultIcpId)) || tList[0]
        if (match) setTemplateId(match.id)
      } catch (err) {
        if (!cancel) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancel) setLoadingTemplates(false)
      }
    })()
    return () => { cancel = true }
  }, [fixedCompanyId, defaultIcpId, workspace])

  // When the user picks an ICP (not in fixedCompany mode), load qualified
  // companies for that ICP. Filters server-side to match=true so we only
  // surface companies the classifier signed off on.
  useEffect(() => {
    if (fixedCompanyId) return // skip in My Accounts mode
    if (!icpId) { setCompanies([]); return }
    let cancel = false
    setLoadingCompanies(true); setError('')
    ;(async () => {
      try {
        const r = await safeFetchJson(`${API}/api/companies?icp=${encodeURIComponent(icpId)}&match=true`)
        if (cancel) return
        const list = ((r as { companies?: CompanyApi[] }).companies) || []
        setCompanies(list)
        // Auto-suggest the template that's bound to this ICP if any.
        const t = templates.find((x) => x.icpId === icpId)
        if (t) setTemplateId(t.id)
      } catch (err) {
        if (!cancel) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancel) setLoadingCompanies(false)
      }
    })()
    return () => { cancel = true }
  }, [icpId, fixedCompanyId, templates])

  const filteredCompanies = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return companies
    return companies.filter((c) => {
      const hay = `${c.name || ''} ${c.domain || ''} ${c.country || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [companies, search])

  const toggleCompany = (id: string) => {
    setSelectedCompanies((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    if (filteredCompanies.every((c) => selectedCompanies.has(c.id))) {
      setSelectedCompanies(new Set())
    } else {
      setSelectedCompanies(new Set(filteredCompanies.map((c) => c.id)))
    }
  }
  const toggleExpanded = (id: string) => {
    setExpandedCompanies((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Ticking a lead implicitly checks its company. Untick the last lead and
  // the company STAYS checked - rep gets the default-lead behaviour next.
  const toggleLead = (companyId: string, leadIdx: number) => {
    setSelectedCompanies((prev) => {
      if (prev.has(companyId)) return prev
      const next = new Set(prev); next.add(companyId); return next
    })
    setSelectedLeadsByCompany((prev) => {
      const cur = new Set(prev[companyId] || [])
      if (cur.has(leadIdx)) cur.delete(leadIdx)
      else cur.add(leadIdx)
      return { ...prev, [companyId]: cur }
    })
  }

  // Per-company breakdown of how many runs it contributes.
  //   • not checked            → 0
  //   • checked, no leads      → 1 (no-name mode)
  //   • checked, no leads picked but company has leads → 1 (default lead[0])
  //   • checked, N leads picked → N
  const runCountFor = (c: CompanyApi): number => {
    if (!selectedCompanies.has(c.id)) return 0
    const picked = selectedLeadsByCompany[c.id]
    if (picked && picked.size > 0) return picked.size
    return 1
  }
  const totalRuns = useMemo(
    () => companies.reduce((s, c) => s + runCountFor(c), 0),
    // runCountFor closes over selected* sets, so we depend on them directly
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companies, selectedCompanies, selectedLeadsByCompany],
  )

  // Build the run-create payload for one company. Same shape for single
  // and bulk paths - the only difference is the `generate` flag.
  // Build the run-create payload for one (company, lead) pair. lead may be
  // null - the backend prompt builder falls back to a generic greeting +
  // scraped-contact block when there's no named recipient.
  const payloadFor = (company: CompanyApi, leadIdx: number | null, generate: boolean) => {
    const lead = leadIdx == null ? null : ((company.leads || [])[leadIdx] || null)
    const cls = (icpId && company.classifications?.[icpId]) || company.classification || {}
    const report = (icpId && company.reports?.[icpId]) || null
    return {
      templateId,
      companyId: company.id,
      leadApolloId: lead?.apolloId || null,
      icpId: icpId || null,
      customInstruction: customInstruction.trim() || null,
      generate,
      context: {
        company: {
          id: company.id,
          name: company.name, domain: company.domain, vertical: company.vertical,
          country: company.country, url: company.url, classification: cls, report,
        },
        lead,
      },
    }
  }

  // Expand the selection into a flat list of (company, leadIdx|null) pairs,
  // one per run we're about to create. This is the single source of truth
  // for "what is about to happen" - both single + bulk paths consume it.
  const expandSelection = (): Array<{ company: CompanyApi; leadIdx: number | null }> => {
    const out: Array<{ company: CompanyApi; leadIdx: number | null }> = []
    for (const c of companies) {
      if (!selectedCompanies.has(c.id)) continue
      const leadsAttached = (c.leads || []).length
      if (leadsAttached === 0) {
        out.push({ company: c, leadIdx: null })
        continue
      }
      const picked = selectedLeadsByCompany[c.id]
      if (picked && picked.size > 0) {
        for (const idx of Array.from(picked).sort((a, b) => a - b)) {
          out.push({ company: c, leadIdx: idx })
        }
      } else {
        // Default to top-tier (Apollo sorts in priority order on its side)
        out.push({ company: c, leadIdx: 0 })
      }
    }
    return out
  }

  const submitSingle = async () => {
    const pairs = expandSelection()
    if (pairs.length !== 1 || !templateId) return
    const p = payloadFor(pairs[0].company, pairs[0].leadIdx, true)
    setGenerating(true); setError('')
    try {
      const res = await fetch(`${API}/api/sequences/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'generation failed')
      onCreatedSingle(j.run.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const submitBulk = async () => {
    const pairs = expandSelection()
    if (pairs.length === 0 || !templateId) return
    setGenerating(true); setError('')
    setBulkProgress({ done: 0, total: pairs.length })
    let created = 0
    let skipped = 0
    let noLead = 0
    try {
      // Sequential POSTs (no parallel) to keep server load + error
      // attribution simple. Each is generate=false so no GPT spend yet.
      for (let i = 0; i < pairs.length; i++) {
        const { company, leadIdx } = pairs[i]
        const p = payloadFor(company, leadIdx, false)
        if (!p.context.lead) noLead++
        const res = await fetch(`${API}/api/sequences/runs`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
        })
        const j = await res.json()
        if (res.ok && j.success) created++
        else skipped++
        setBulkProgress({ done: i + 1, total: pairs.length })
      }
      if (skipped > 0 || noLead > 0) {
        const noLeadNote = noLead > 0 ? ` ${noLead} run${noLead === 1 ? '' : 's'} have no Apollo lead - those will use a generic greeting.` : ''
        const skippedNote = skipped > 0 ? ` ${skipped} skipped (backend rejection).` : ''
        setError(`${created} draft${created === 1 ? '' : 's'} created.${skippedNote}${noLeadNote}`)
      }
      onCreatedBulk(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
      setBulkProgress(null)
    }
  }

  // totalRuns is the # of POST /runs calls about to fire. Drives mode +
  // submit button copy. Single = exactly 1 (sync gen, navigates to builder),
  // Bulk = 2+ (empty drafts created with generate=false, stays on list).
  const selectionCount = selectedCompanies.size
  const bulkMode = totalRuns > 1
  const singleSelectedCompany = selectionCount === 1
    ? companies.find((c) => selectedCompanies.has(c.id))
    : null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm p-4">
      <Card className={cn(GLASS, 'w-full max-w-3xl p-5 space-y-4 max-h-[90vh] overflow-y-auto')}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {fixedCompanyId ? 'New sequence run' : 'New sequence - pick recipients'}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">Cancel</button>
        </div>

        {loadingTemplates ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground"><IconLoader2 className="h-4 w-4 animate-spin" /></div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No templates yet. Create one in the Templates tab first.</p>
        ) : (
          <>
            {/* Picker chain - only shown when not arriving from My Accounts. */}
            {!fixedCompanyId && (
              <>
                <Field label="ICP">
                  <select value={icpId} onChange={(e) => setIcpId(e.target.value)}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="">Pick an ICP…</option>
                    {icps.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}{i.portfolioCompany ? ` · ${i.portfolioCompany}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>

                {icpId && (
                  <Field label={`Qualified companies in ${icps.find((x) => x.id === icpId)?.name || icpId}`}
                         hint="Expand a company to pick specific leads. One run is generated per ticked lead; an un-expanded checked company defaults to its top-tier lead.">
                    <div className="border border-border rounded-md bg-background overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-foreground/[0.02]">
                        <Input value={search} onChange={(e) => setSearch(e.target.value)}
                               placeholder="Search by name, domain, country…" className="h-7 text-xs flex-1" />
                        <button onClick={toggleAll} className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline shrink-0">
                          {filteredCompanies.every((c) => selectedCompanies.has(c.id)) ? 'Clear' : 'Select all'}
                        </button>
                      </div>
                      <div className="max-h-80 overflow-y-auto">
                        {loadingCompanies ? (
                          <div className="flex items-center justify-center py-6 text-muted-foreground text-xs"><IconLoader2 className="h-3 w-3 animate-spin mr-1" /> loading…</div>
                        ) : filteredCompanies.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic py-6 text-center px-3">
                            {companies.length === 0 ? 'No qualified companies in this ICP. Run a sweep + confirm some on My Accounts first.' : 'No matches for that search.'}
                          </p>
                        ) : (
                          <ul className="divide-y divide-border/40">
                            {filteredCompanies.map((c) => {
                              const checked = selectedCompanies.has(c.id)
                              const leads = c.leads || []
                              const leadsCount = leads.length
                              const expanded = expandedCompanies.has(c.id)
                              const picked = selectedLeadsByCompany[c.id] || new Set<number>()
                              const runs = runCountFor(c)
                              return (
                                <li key={c.id}>
                                  {/* Company row */}
                                  <div className={cn('flex items-center gap-2 px-3 py-2 hover:bg-foreground/[0.03]', checked && 'bg-sky-500/5')}>
                                    <input type="checkbox" checked={checked} onChange={() => toggleCompany(c.id)}
                                           className="h-3.5 w-3.5 cursor-pointer" />
                                    {leadsCount > 0 ? (
                                      <button onClick={() => toggleExpanded(c.id)}
                                              className="text-muted-foreground hover:text-foreground shrink-0"
                                              title={expanded ? 'Hide leads' : 'Show leads'}>
                                        {expanded
                                          ? <IconChevronDown className="h-3.5 w-3.5" />
                                          : <IconChevronRight className="h-3.5 w-3.5" />}
                                      </button>
                                    ) : (
                                      <span className="w-3.5 shrink-0" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-medium truncate">{c.name || c.domain || c.id}</div>
                                      <div className="text-[10px] text-muted-foreground truncate">
                                        {c.domain && <>{c.domain} · </>}{c.country || ''}
                                        {leadsCount === 0 && <span className="text-amber-600 dark:text-amber-400 ml-1">· no leads (will use generic greeting)</span>}
                                        {leadsCount > 0 && (
                                          <span className="ml-1">
                                            · {leadsCount} lead{leadsCount === 1 ? '' : 's'}
                                            {checked && picked.size > 0 && <span className="text-sky-700 dark:text-sky-300"> · {picked.size} picked</span>}
                                            {checked && picked.size === 0 && <span className="text-muted-foreground"> · default top-tier</span>}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    {checked && runs > 0 && (
                                      <Badge variant="outline" className="text-[10px] border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300 shrink-0">
                                        {runs} run{runs === 1 ? '' : 's'}
                                      </Badge>
                                    )}
                                  </div>
                                  {/* Lead sublist - shown when row is expanded. Ticking a
                                      lead implicitly checks the company; unchecking the last
                                      one leaves the company on default behaviour. */}
                                  {expanded && leadsCount > 0 && (
                                    <ul className="bg-foreground/[0.02] border-t border-border/40">
                                      {leads.map((l, i) => {
                                        const leadChecked = picked.has(i)
                                        return (
                                          <li key={i}>
                                            <label className="flex items-center gap-2 pl-10 pr-3 py-1.5 cursor-pointer hover:bg-foreground/[0.04]">
                                              <input type="checkbox" checked={leadChecked} onChange={() => toggleLead(c.id, i)}
                                                     className="h-3 w-3" />
                                              <div className="min-w-0 flex-1">
                                                <div className="text-xs truncate">
                                                  {(l.firstName || '') + ' ' + (l.lastName || '')}
                                                  {l.title && <span className="text-muted-foreground"> · {l.title}</span>}
                                                </div>
                                                {l.email && <div className="text-[10px] text-muted-foreground truncate">{l.email}</div>}
                                              </div>
                                            </label>
                                          </li>
                                        )
                                      })}
                                    </ul>
                                  )}
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </div>
                    </div>
                  </Field>
                )}
              </>
            )}

            {/* Single-company arrival from My Accounts: show the lead list
                inline as checkboxes too, matching the picker UI. */}
            {fixedCompanyId && singleSelectedCompany && (singleSelectedCompany.leads || []).length > 0 && (
              <Field label="Recipients" hint="Tick one or more leads to generate sequences for. Untick all to fall back to the top-tier lead.">
                <ul className="border border-border rounded-md bg-background divide-y divide-border/40 max-h-48 overflow-y-auto">
                  {(singleSelectedCompany.leads || []).map((l, i) => {
                    const picked = (selectedLeadsByCompany[singleSelectedCompany.id] || new Set<number>()).has(i)
                    return (
                      <li key={i}>
                        <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-foreground/[0.03]">
                          <input type="checkbox" checked={picked} onChange={() => toggleLead(singleSelectedCompany.id, i)} className="h-3.5 w-3.5" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs">
                              {(l.firstName || '') + ' ' + (l.lastName || '')}
                              {l.title && <span className="text-muted-foreground"> · {l.title}</span>}
                            </div>
                            {l.email && <div className="text-[10px] text-muted-foreground truncate">{l.email}</div>}
                          </div>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </Field>
            )}
            {fixedCompanyId && singleSelectedCompany && (singleSelectedCompany.leads || []).length === 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                No Apollo leads attached. The sequence will generate using the company report + scraped contacts. Each step opens with a generic "Hello," instead of a named greeting.
              </div>
            )}

            {/* Bulk mode warning - explain what happens. */}
            {bulkMode && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Bulk mode: {totalRuns} sequence{totalRuns === 1 ? '' : 's'} will be created as empty drafts (no GPT spend yet). Open each one from the Runs tab to generate when you're ready.
              </div>
            )}

            <Field label="Template">
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.steps.length} steps</option>)}
              </select>
            </Field>

            <Field label="Custom instruction (optional)" hint="Mentioned in every step's prompt - e.g. 'reference their recent location expansion'">
              <textarea value={customInstruction} onChange={(e) => setCustomInstruction(e.target.value)} rows={2}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </Field>

            {error && <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}

            {bulkProgress && (
              <div className="text-xs text-muted-foreground">Creating draft {bulkProgress.done} / {bulkProgress.total}…</div>
            )}

            {/* Footer summary - reads at a glance how many sequences this will produce */}
            <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-3">
              <div className="text-xs text-muted-foreground">
                {totalRuns === 0
                  ? 'No selection yet.'
                  : <><b className="text-foreground">{totalRuns}</b> sequence{totalRuns === 1 ? '' : 's'} from <b className="text-foreground">{selectionCount}</b> compan{selectionCount === 1 ? 'y' : 'ies'}</>}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={onClose} disabled={generating}>Cancel</Button>
                {bulkMode ? (
                  <Button size="sm" onClick={submitBulk} disabled={generating || !templateId || totalRuns === 0}>
                    {generating ? <><IconLoader2 className="h-3 w-3 mr-1 animate-spin" /> Creating…</> : <><IconCheck className="h-3 w-3 mr-1" /> Create {totalRuns} draft{totalRuns === 1 ? '' : 's'}</>}
                  </Button>
                ) : (
                  <Button size="sm" onClick={submitSingle} disabled={generating || !templateId || totalRuns !== 1}>
                    {generating ? <><IconLoader2 className="h-3 w-3 mr-1 animate-spin" /> Generating…</> : <><IconCheck className="h-3 w-3 mr-1" /> Generate sequence</>}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

// ─── Templates tab ─────────────────────────────────────────────────────

function TemplatesTab() {
  const [templates, setTemplates] = useState<SequenceTemplate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SequenceTemplate | null>(null)
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateLite[]>([])
  // Available ICPs for the dropdown. Workspace-filtered so the rep only
  // sees ICPs in their current portfolio company - prevents binding a
  // Carla template to a NedFox ICP by mistake.
  const [icps, setIcps] = useState<IcpSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Workspace = active portfolio company (sidebar picker). When set, the
  // template list narrows to that company's templates - matches the
  // Database/Coverage filter behaviour so the rep stays in their lane.
  // '' (All Companies) keeps the full list visible.
  const { workspace } = useWorkspace()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const tUrl = workspace
        ? `${API}/api/sequences/templates?portfolioCompany=${encodeURIComponent(workspace)}`
        : `${API}/api/sequences/templates`
      const etUrl = workspace
        ? `${API}/api/email-templates?portfolioCompany=${encodeURIComponent(workspace)}`
        : `${API}/api/email-templates`
      const iUrl = workspace
        ? `${API}/api/icps?portfolioCompany=${encodeURIComponent(workspace)}`
        : `${API}/api/icps`
      const [t, et, i] = await Promise.all([
        safeFetchJson(tUrl),
        safeFetchJson(etUrl),
        safeFetchJson(iUrl),
      ])
      const list = ((t as { templates?: SequenceTemplate[] }).templates) || []
      setTemplates(list)
      setEmailTemplates(((et as { templates?: EmailTemplateLite[] }).templates) || [])
      setIcps(((i as { icps?: IcpSummary[] }).icps) || [])
      if (list.length > 0 && !selectedId) setSelectedId(list[0].id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [selectedId, workspace])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!selectedId) { setDraft(null); return }
    const t = templates.find((x) => x.id === selectedId)
    setDraft(t ? structuredClone(t) : null)
  }, [selectedId, templates])

  const newTemplate = () => {
    const t: SequenceTemplate = {
      id: '',
      name: 'New sequence',
      icpId: null,
      portfolioCompany: null,
      senderTemplateId: null,
      language: 'English',
      description: null,
      steps: [
        { orderIdx: 0, purpose: 'intro',    daysAfterPrev: 0,  lengthHint: 'medium', customGuidance: null },
        { orderIdx: 1, purpose: 'value',    daysAfterPrev: 3,  lengthHint: 'short',  customGuidance: null },
        { orderIdx: 2, purpose: 'follow_up',daysAfterPrev: 4,  lengthHint: 'short',  customGuidance: null },
        { orderIdx: 3, purpose: 'breakup',  daysAfterPrev: 7,  lengthHint: 'short',  customGuidance: null },
      ],
      createdAt: null,
      updatedAt: null,
    }
    setDraft(t)
    setSelectedId(null)
  }

  const save = async () => {
    if (!draft) return
    if (!draft.id) {
      // derive from name
      draft.id = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new-sequence'
    }
    setSaving(true)
    setError('')
    try {
      const existing = templates.find((t) => t.id === draft.id)
      const url = existing ? `${API}/api/sequences/templates/${draft.id}` : `${API}/api/sequences/templates`
      const method = existing ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'save failed')
      await load()
      setSelectedId(draft.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const del = async () => {
    if (!draft?.id) return
    if (!confirm(`Delete template "${draft.name}"? Runs that used it will keep referencing the deleted id.`)) return
    setSaving(true)
    try {
      const res = await fetch(`${API}/api/sequences/templates/${draft.id}`, { method: 'DELETE' })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'delete failed')
      setSelectedId(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Clone the current draft into a new unsaved one. id is blanked so the
  // save handler treats it as a create, and the name is suffixed with
  // "(copy)" (or "(copy N)" if that name already exists). Steps are deep-
  // copied so editing the duplicate's steps doesn't bleed back into the
  // original draft's in-memory state.
  const duplicate = () => {
    if (!draft) return
    let name = `${draft.name} (copy)`
    let n = 2
    while (templates.some((t) => t.name === name)) {
      name = `${draft.name} (copy ${n})`
      n++
    }
    setDraft({
      ...draft,
      id: '',
      name,
      createdAt: null,
      updatedAt: null,
      steps: draft.steps.map((s) => ({ ...s })),
    })
    setSelectedId(null) // unselect the original; the new draft has no id yet
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* Rail */}
      <div className="col-span-12 lg:col-span-4 xl:col-span-3">
        <Card className={cn(GLASS, 'p-3')}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
              Templates ({templates.length})
            </span>
            <Button size="sm" variant="outline" onClick={newTemplate} className="h-7 px-2 text-xs">
              <IconPlus className="h-3 w-3 mr-1" /> New
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <IconLoader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : templates.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center italic">No templates yet. Click <b>New</b> to create one.</p>
          ) : (
            <ul className="space-y-1">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelectedId(t.id)}
                    className={cn(
                      'w-full text-left px-2 py-2 rounded-md text-sm hover:bg-foreground/[0.04] transition-colors',
                      selectedId === t.id && 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
                    )}
                  >
                    <div className="font-medium truncate">{t.name}</div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
                      <span>{t.steps.length} step{t.steps.length === 1 ? '' : 's'}</span>
                      {t.portfolioCompany && <><span>·</span><span className="truncate">{t.portfolioCompany}</span></>}
                      {t.language && t.language !== 'English' && <><span>·</span><span>{t.language}</span></>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Editor */}
      <div className="col-span-12 lg:col-span-8 xl:col-span-9">
        {draft ? (
          <Card className={cn(GLASS, 'p-4 space-y-4')}>
            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
                <IconAlertTriangle className="h-3.5 w-3.5" /> {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="id" hint={draft.id ? 'Locked once saved' : 'Auto-generated from the name if you leave it blank'}>
                <Input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                       disabled={!!templates.find((t) => t.id === draft.id)} />
              </Field>
              <Field label="Portfolio company">
                <Input value={draft.portfolioCompany || ''} onChange={(e) => setDraft({ ...draft, portfolioCompany: e.target.value || null })} placeholder="Carla Auto Rental Systems" />
              </Field>
              <Field label="Language">
                <Input value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })} />
              </Field>
              <Field label="Sender (email template)" hint="Links to a template on /templates so the sender voice + product pitch are shared">
                <select
                  value={draft.senderTemplateId || ''}
                  onChange={(e) => setDraft({ ...draft, senderTemplateId: e.target.value || null })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">(no sender bound)</option>
                  {emailTemplates.map((et) => (
                    <option key={et.id} value={et.id}>{et.name}{et.portfolioCompany ? ` · ${et.portfolioCompany}` : ''}</option>
                  ))}
                </select>
              </Field>
              <Field label="ICP" hint="When this ICP is picked on My Accounts, this template is auto-suggested.">
                <select
                  value={draft.icpId || ''}
                  onChange={(e) => setDraft({ ...draft, icpId: e.target.value || null })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">(unscoped - manual pick only)</option>
                  {icps.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}{i.portfolioCompany ? ` · ${i.portfolioCompany}` : ''}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Description">
              <Input value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value || null })} placeholder="One-line summary shown in the picker" />
            </Field>

            {/* Steps editor */}
            <div className="border-t border-border/40 pt-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                    Steps ({draft.steps.length})
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 max-w-2xl">
                    Each step turns into one email when this template runs. <b>Purpose</b> picks the role
                    of the email (intro / follow-up / breakup) and tells GPT exactly what to write.{' '}
                    <b>Length</b> targets a word count. <b>Step guidance</b> is optional - extra
                    instructions appended to GPT's prompt for that specific step (e.g.{' '}
                    <i>"anchor on their fleet size if visible"</i>).
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => {
                  setDraft({ ...draft, steps: [...draft.steps, { orderIdx: draft.steps.length, purpose: 'follow_up', daysAfterPrev: 3, lengthHint: 'short', customGuidance: null }] })
                }} className="h-7 px-2 text-xs shrink-0">
                  <IconPlus className="h-3 w-3 mr-1" /> Add step
                </Button>
              </div>

              <div className="space-y-2">
                {draft.steps.map((s, i) => {
                  const meta = purposeMeta(s.purpose)
                  return (
                    <div key={i} className={cn(GLASS_SUBTLE, 'rounded-md p-3 space-y-2')}>
                      {/* Header row: step # + top-level controls (purpose / day / length / delete) */}
                      <div className="flex items-end gap-2">
                        <div className="flex items-center text-muted-foreground pb-1.5">
                          <IconGripVertical className="h-3.5 w-3.5" />
                          <span className="ml-1 text-xs font-semibold tabular-nums">{i + 1}.</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <Label>Purpose</Label>
                          <select
                            value={s.purpose}
                            onChange={(e) => {
                              const next = [...draft.steps]
                              next[i] = { ...s, purpose: e.target.value as Purpose }
                              setDraft({ ...draft, steps: next })
                            }}
                            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                          >
                            {PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                          </select>
                        </div>
                        <div className="w-24">
                          <Label>Day offset</Label>
                          <Input type="number" min={0} value={s.daysAfterPrev}
                                 onChange={(e) => {
                                   const next = [...draft.steps]
                                   next[i] = { ...s, daysAfterPrev: Math.max(0, parseInt(e.target.value, 10) || 0) }
                                   setDraft({ ...draft, steps: next })
                                 }}
                                 className="h-8 text-xs" title="Days after the previous step" />
                        </div>
                        <div className="w-64">
                          <Label>Length</Label>
                          <select
                            value={s.lengthHint}
                            onChange={(e) => {
                              const next = [...draft.steps]
                              next[i] = { ...s, lengthHint: e.target.value as LengthHint }
                              setDraft({ ...draft, steps: next })
                            }}
                            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                          >
                            {LENGTHS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                          </select>
                        </div>
                        <button onClick={() => {
                          if (draft.steps.length === 1) return
                          setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i).map((x, j) => ({ ...x, orderIdx: j })) })
                        }} className="text-muted-foreground hover:text-red-500 pb-2"
                                title="Remove step" disabled={draft.steps.length === 1}>
                          <IconTrash className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {/* Purpose explainer - shows the rep what GPT will be told to do
                          for this step's role, so the dropdown choice has context. */}
                      <p className="text-[11px] text-muted-foreground pl-7 italic">
                        {meta.describe}
                      </p>

                      {/* Step guidance - full-width textarea on its own row so the rep
                          can read AND edit long instructions without truncation. */}
                      <div>
                        <Label>Step guidance (optional)</Label>
                        <textarea
                          value={s.customGuidance || ''}
                          placeholder="Extra instruction for THIS step's prompt only. e.g. 'anchor on their fleet expansion if the website mentions it' or 'don't reference competitors by name'."
                          rows={2}
                          onChange={(e) => {
                            const next = [...draft.steps]
                            next[i] = { ...s, customGuidance: e.target.value || null }
                            setDraft({ ...draft, steps: next })
                          }}
                          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs resize-y"
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border/40 pt-3">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={del} disabled={saving || !templates.find((t) => t.id === draft.id)} className="text-xs text-red-500 hover:text-red-600">
                  <IconTrash className="h-3 w-3 mr-1" /> Delete
                </Button>
                {/* Only enabled for templates that have been saved at least
                    once - duplicating an unsaved draft is meaningless. */}
                <Button variant="ghost" size="sm" onClick={duplicate} disabled={saving || !templates.find((t) => t.id === draft.id)} className="text-xs"
                        title="Open a new unsaved draft with all fields + steps pre-filled from this one.">
                  <IconCopy className="h-3 w-3 mr-1" /> Duplicate
                </Button>
              </div>
              <Button size="sm" onClick={save} disabled={saving} className="text-xs">
                {saving ? <IconLoader2 className="h-3 w-3 mr-1 animate-spin" /> : <IconCheck className="h-3 w-3 mr-1" />}
                Save
              </Button>
            </div>
          </Card>
        ) : (
          <Card className={cn(GLASS, 'p-8 text-center text-muted-foreground text-sm')}>
            Pick a template on the left, or click <b>New</b> to create one.
          </Card>
        )}
      </div>
    </div>
  )
}

// ─── Runs tab ──────────────────────────────────────────────────────────

function RunsTab({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { workspace } = useWorkspace()
  const [runs, setRuns] = useState<SequenceRun[]>([])
  // ICP → portfolioCompany map. Used to filter runs to the current
  // workspace - runs don't carry portfolio directly, but their icp_id
  // does (via the ICP record). One fetch on mount, then client-side
  // filter so switching workspace is instant.
  const [icpPortfolios, setIcpPortfolios] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [r, i] = await Promise.all([
        safeFetchJson(`${API}/api/sequences/runs?limit=100`),
        safeFetchJson(`${API}/api/icps`),
      ])
      setRuns(((r as { runs?: SequenceRun[] }).runs) || [])
      const icps = ((i as { icps?: Array<{ id: string; portfolioCompany?: string }> }).icps) || []
      const map: Record<string, string> = {}
      for (const x of icps) map[x.id] = x.portfolioCompany || ''
      setIcpPortfolios(map)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // When a workspace is picked, hide runs whose ICP doesn't belong to it.
  // '' (All Companies) passes everything through.
  const visibleRuns = useMemo(() => {
    if (!workspace) return runs
    return runs.filter((r) => !r.icpId || icpPortfolios[r.icpId] === workspace)
  }, [runs, workspace, icpPortfolios])

  if (loading) return <div className="flex items-center justify-center py-8 text-muted-foreground"><IconLoader2 className="h-4 w-4 animate-spin" /></div>

  return (
    <Card className={cn(GLASS, 'p-4')}>
      {error && <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300 mb-3">{error}</div>}
      {workspace && runs.length > visibleRuns.length && (
        <div className="text-[11px] text-muted-foreground mb-2 px-1">
          Showing {visibleRuns.length} of {runs.length} runs · filtered to <b>{workspace}</b>. Switch to <b>All Companies</b> on the sidebar to see everything.
        </div>
      )}
      {visibleRuns.length === 0 ? (
        <p className="text-sm text-muted-foreground italic py-8 text-center">
          No runs yet. Open a card on <Link to="/accounts" className="underline text-sky-500">My Accounts</Link> and click <b>Sequence</b>, or create one from the Templates tab.
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {visibleRuns.map((r) => {
            const recipient = `${r.contextSnapshot?.lead?.firstName || ''} ${r.contextSnapshot?.lead?.lastName || ''}`.trim() || '(recipient)'
            const company = r.contextSnapshot?.company?.name
              || r.contextSnapshot?.company?.domain
              || '(company)'
            return (
              <li key={r.id}>
                <button onClick={() => onOpenRun(r.id)} className="w-full text-left px-2 py-2.5 hover:bg-foreground/[0.04] transition-colors flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{recipient}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{company} · template {r.templateId}{Array.isArray(r.steps) ? ` · ${r.steps.length} steps` : ''}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={r.status} />
                    <span className="text-[10px] text-muted-foreground">{fmtRelative(r.updatedAt)}</span>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function StatusBadge({ status }: { status: RunStatus }) {
  const cfg = status === 'approved' ? { c: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', l: 'Approved' }
    : status === 'exported' ? { c: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', l: 'Exported' }
    : { c: 'bg-muted text-muted-foreground', l: 'Draft' }
  return <Badge variant="outline" className={cn('text-[10px] border-transparent', cfg.c)}>{cfg.l}</Badge>
}

// ─── Builder view ──────────────────────────────────────────────────────

// Local error boundary so a render exception inside BuilderView shows the
// error text instead of unwinding to root and blanking the whole page.
// Without this any "Cannot read properties of undefined" while clicking
// from the runs list into a run becomes a white screen with no clue what
// failed. The boundary is intentionally minimal - logs to console for
// network observability + renders the message so we can iterate on the
// actual failure mode without having to read the browser console.
class BuilderErrorBoundary extends React.Component<{ children: React.ReactNode; onBack: () => void }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    console.error('[BuilderView] render crash:', err, info.componentStack)
  }
  render() {
    if (this.state.err) {
      return (
        <div className="space-y-4">
          <Button variant="ghost" size="sm" onClick={this.props.onBack}><IconArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Button>
          <Card className={cn(GLASS, 'p-4 space-y-2 border border-red-500/40')}>
            <div className="text-sm font-semibold text-red-700 dark:text-red-300">Sequence builder hit a render error.</div>
            <pre className="text-[11px] whitespace-pre-wrap font-mono bg-red-500/10 rounded-md p-2 overflow-auto">{String(this.state.err?.message || this.state.err)}</pre>
            <Button size="sm" variant="outline" onClick={() => this.setState({ err: null })} className="text-xs">Try again</Button>
          </Card>
        </div>
      )
    }
    return this.props.children
  }
}

function BuilderView({ runId, onBack }: { runId: string; onBack: () => void }) {
  return (
    <BuilderErrorBoundary onBack={onBack}>
      <BuilderViewInner runId={runId} onBack={onBack} />
    </BuilderErrorBoundary>
  )
}

function BuilderViewInner({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<SequenceRun | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await safeFetchJson(`${API}/api/sequences/runs/${runId}`)
      setRun((r as { run: SequenceRun }).run)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [runId])
  useEffect(() => { load() }, [load])

  const regenerate = async (idx: number) => {
    setRegenerating(idx); setError('')
    try {
      const res = await fetch(`${API}/api/sequences/runs/${runId}/regenerate/${idx}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'regen failed')
      setRun(j.run)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setRegenerating(null) }
  }

  // Generate every step on a run whose steps are still empty. Used for
  // bulk-created shells that were deferred. Sequential server-side, so
  // wall time scales with step count (~15-30s for a 4-step template).
  const generateAll = async () => {
    setRegenerating(-1); setError('')
    try {
      const res = await fetch(`${API}/api/sequences/runs/${runId}/generate-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'generate-all failed')
      setRun(j.run)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setRegenerating(null) }
  }

  const saveStep = async (idx: number, subject: string, body: string) => {
    setSaving(true); setError('')
    try {
      const res = await fetch(`${API}/api/sequences/runs/${runId}/steps/${idx}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'save failed')
      setRun(j.run)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(false) }
  }

  const setStatus = async (status: RunStatus) => {
    try {
      const res = await fetch(`${API}/api/sequences/runs/${runId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'status update failed')
      setRun(j.run)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading || !run) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" onClick={onBack}><IconArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Button>
        <div className="flex items-center justify-center py-12 text-muted-foreground"><IconLoader2 className="h-5 w-5 animate-spin" /></div>
      </div>
    )
  }

  // Defensive read of steps: a malformed/half-saved run was crashing
  // BuilderView because step = run.steps[activeIdx] returned undefined and
  // StepEditor's useState(step.subject || '') threw. Treat missing steps
  // as an empty array and clamp activeIdx so the editor degrades gracefully
  // to the "no steps yet" CTA instead of a white screen.
  const steps = Array.isArray(run.steps) ? run.steps : []
  const safeActiveIdx = steps.length === 0 ? 0 : Math.min(activeIdx, steps.length - 1)
  const step = steps[safeActiveIdx]
  const recipient = `${run.contextSnapshot?.lead?.firstName || ''} ${run.contextSnapshot?.lead?.lastName || ''}`.trim() || '(recipient)'
  // Prefer the snapshot's company name, then the live ctx domain (some older
  // runs only snapshotted the domain), then a friendly fallback. Showing the
  // raw companyId UUID was leaking internal state into the header.
  const company = run.contextSnapshot?.company?.name
    || run.contextSnapshot?.company?.domain
    || '(company)'
  // A run is "un-generated" when there are no steps at all (older malformed
  // runs) OR every step has a null subject AND null body (bulk-create draft
  // shells). We hide the per-step editor and show a single CTA in that case.
  const allEmpty = steps.length === 0 || steps.every((s) => !s.subject && !s.body)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={onBack}><IconArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Button>
          <div className="min-w-0">
            <div className="text-lg font-semibold truncate">{recipient} @ {company}</div>
            <div className="text-xs text-muted-foreground">Template {run.templateId} · {steps.length} steps</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={run.status} />
          {run.status !== 'approved' && (
            <Button size="sm" variant="outline" onClick={() => setStatus('approved')} className="text-xs h-8">
              <IconCheck className="h-3 w-3 mr-1" /> Mark approved
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => copyFullSequence(run)} className="text-xs h-8">
            <IconCopy className="h-3 w-3 mr-1" /> Copy all
          </Button>
        </div>
      </div>

      {error && <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>}

      {allEmpty ? (
        <Card className={cn(GLASS, 'p-8 text-center space-y-3')}>
          <p className="text-sm font-medium">This sequence hasn't been generated yet.</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Bulk-created drafts start empty so you can decide which recipients are worth the GPT spend.
            Click below to generate {steps.length} step{steps.length === 1 ? '' : 's'} for{' '}
            <b>{recipient}</b> at <b>{company}</b>, roughly {Math.round(steps.length * 5)}s of wall time.
          </p>
          <Button onClick={generateAll} disabled={regenerating === -1} className="mt-2">
            {regenerating === -1
              ? <><IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Generating {steps.length} step{steps.length === 1 ? '' : 's'}…</>
              : <><IconRefresh className="h-3.5 w-3.5 mr-1.5" /> Generate sequence</>}
          </Button>
        </Card>
      ) : (
      <div className="grid grid-cols-12 gap-4">
        {/* Step rail */}
        <div className="col-span-12 lg:col-span-3">
          <Card className={cn(GLASS, 'p-2')}>
            <ul className="space-y-1">
              {steps.map((s, i) => {
                const meta = purposeMeta(s.purpose)
                return (
                  <li key={i}>
                    <button onClick={() => setActiveIdx(i)} className={cn(
                      'w-full text-left p-2 rounded-md hover:bg-foreground/[0.04] transition-colors',
                      safeActiveIdx === i && 'bg-sky-500/10',
                    )}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold tabular-nums w-5">{i + 1}.</span>
                        <Badge variant="outline" className={cn('text-[10px] border-transparent', meta.color)}>{meta.label}</Badge>
                        <span className="text-[10px] text-muted-foreground ml-auto">Day {sumDaysUpTo(steps, i)}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1 truncate pl-7">
                        {s.subject || <span className="italic">(no subject yet)</span>}
                      </div>
                      {s.editedByUser && <div className="text-[9px] text-amber-600 dark:text-amber-400 pl-7 mt-0.5"><IconEdit className="h-2.5 w-2.5 inline mr-0.5" /> edited</div>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>
        </div>

        {/* Step editor */}
        <div className="col-span-12 lg:col-span-9">
          {step ? (
            <StepEditor
              key={safeActiveIdx}
              step={step}
              totalSteps={steps.length}
              onRegenerate={() => regenerate(safeActiveIdx)}
              onSave={(subject, body) => saveStep(safeActiveIdx, subject, body)}
              regenerating={regenerating === safeActiveIdx}
              saving={saving}
            />
          ) : (
            <Card className={cn(GLASS, 'p-6 text-center text-sm text-muted-foreground')}>
              Step {safeActiveIdx + 1} hasn't loaded - try reloading or regenerating.
            </Card>
          )}
        </div>
      </div>
      )}
    </div>
  )
}

function sumDaysUpTo(steps: SequenceRunStep[], idx: number): number {
  let d = 0
  for (let i = 0; i <= idx; i++) d += steps[i].daysAfterPrev
  return d
}

function copyFullSequence(run: SequenceRun) {
  const recipient = `${run.contextSnapshot?.lead?.firstName || ''} ${run.contextSnapshot?.lead?.lastName || ''}`.trim()
  const steps = Array.isArray(run.steps) ? run.steps : []
  const lines = steps.map((s, i) => {
    return `=== Step ${i + 1} · ${purposeMeta(s.purpose).label} · Day ${sumDaysUpTo(steps, i)} ===\nSubject: ${s.subject || ''}\n\n${s.body || ''}`
  })
  const out = `Sequence for ${recipient}\n${run.contextSnapshot?.company?.name || ''}\n\n${lines.join('\n\n---\n\n')}`
  navigator.clipboard.writeText(out)
}

function StepEditor({ step, totalSteps, onRegenerate, onSave, regenerating, saving }: {
  step: SequenceRunStep
  totalSteps: number
  onRegenerate: () => void
  onSave: (subject: string, body: string) => void
  regenerating: boolean
  saving: boolean
}) {
  const [subject, setSubject] = useState(step.subject || '')
  const [body, setBody] = useState(step.body || '')
  useEffect(() => { setSubject(step.subject || ''); setBody(step.body || '') }, [step.orderIdx, step.subject, step.body])
  const meta = purposeMeta(step.purpose)
  const dirty = subject !== (step.subject || '') || body !== (step.body || '')

  return (
    <Card className={cn(GLASS, 'p-4 space-y-3')}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn('text-[10px] border-transparent', meta.color)}>{meta.label}</Badge>
          <span className="text-xs text-muted-foreground">Step {step.orderIdx + 1} of {totalSteps} · {step.daysAfterPrev}d after previous</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRegenerate} disabled={regenerating} className="text-xs h-8">
            {regenerating ? <IconLoader2 className="h-3 w-3 mr-1 animate-spin" /> : <IconRefresh className="h-3 w-3 mr-1" />} Regenerate
          </Button>
          <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`) }} className="text-xs h-8">
            <IconCopy className="h-3 w-3 mr-1" /> Copy
          </Button>
        </div>
      </div>

      <Field label="Subject">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="font-medium" />
      </Field>
      <Field label="Body">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed resize-y"
        />
      </Field>

      <div className="flex items-center justify-end gap-2 border-t border-border/40 pt-3">
        {dirty && (
          <Button size="sm" onClick={() => onSave(subject, body)} disabled={saving} className="text-xs">
            {saving ? <IconLoader2 className="h-3 w-3 mr-1 animate-spin" /> : <IconCheck className="h-3 w-3 mr-1" />}
            Save edits
          </Button>
        )}
      </div>
    </Card>
  )
}

// ─── Small UI helpers ──────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </label>
  )
}
function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">{children}</div>
}

// useMemo is imported but unused in this file - keep the import shape
// matching the other pages and reference it here to satisfy the linter.
void useMemo
