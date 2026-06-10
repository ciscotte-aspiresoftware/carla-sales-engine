// /templates - CRUD for per-portfolio-company email templates.
//
// Mirrors the ICPs page pattern: list of cards on the left, edit panel
// on the right. A template owns:
//   • sender persona (firstName, title, company, signoff, email)
//   • systemPrompt - the rules block fed to GPT for tone/voice/structure
//   • voice - a short descriptor that the systemPrompt can reference via
//     the {{voice}} token
//   • language, suitableVerticals, defaultForIcps - discovery metadata
//
// Workspace-scoped - the list narrows to the active workspace's
// portfolio company; "All Companies" shows everything. New templates
// pre-fill `portfolioCompany` with the workspace pick so the rep doesn't
// have to retype it.

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Save, Trash2, X, Mail, AlertCircle, Linkedin } from 'lucide-react'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  fetchEmailTemplates,
  fetchEmailTemplate,
  fetchPortfolioCompanies,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  type EmailTemplate,
  type EmailTemplateSummary,
  type TemplateChannel,
} from '@/lib/api'
import { API_BASE } from '@/lib/api-base'
import { useWorkspace } from '@/context/workspace-context'

// Trimmed ICP shape used by the dropdowns. We don't need the full ICP
// payload here - just enough to render "name (company)" labels.
interface IcpOption {
  id: string
  name: string
  vertical: string
  portfolioCompany: string
}

// Languages available for the dropdown. Full names because that's what
// GPT consumes via the {{language}} token in the system prompt - it
// reads "Write in Dutch" more naturally than "Write in nl". The list is
// intentionally short (the major European markets Valsoft sells into) -
// add more here when a portfolio company needs them. Anything not on
// this list that's already stored on a template (e.g. a legacy "en"
// code) passes through unchanged so old data isn't lost.
const LANGUAGE_OPTIONS: string[] = [
  'English',
  'Dutch',
  'French',
  'German',
  'Spanish',
  'Italian',
  'Portuguese',
]

const EMPTY_TEMPLATE: EmailTemplate = {
  id: '',
  name: '',
  portfolioCompany: '',
  // New templates default to whichever channel tab is active when "New
  // Template" is clicked - see handleNew. This value is the fallback when
  // the tab state isn't available yet.
  channel: 'email',
  defaultForIcps: [],
  language: 'English',
  sender: {
    firstName: '',
    lastName: '',
    title: '',
    company: '',
    email: '',
    signoff: '',
  },
  voice: '',
  systemPrompt: '',
  linkedinGuidance: '',
}

// Mirror of LINKEDIN_UNIVERSAL_RULES in api/prompts/email.js. Surfaced as
// a read-only "Always applied" hint next to the LinkedIn guidance field so
// template editors can see the baked-in rules and write guidance that
// stacks on top instead of duplicating them. KEEP IN SYNC - if you edit
// one, edit both.
const LINKEDIN_UNIVERSAL_RULES = `When LinkedIn data is provided below, treat it as PRIMARY personalization. Your opener MUST reference ONE specific LinkedIn-derived detail from this person's profile or posts - prefer a fresh post (last 3 months), then current role, then a past tenure at a recognizable employer in the same vertical. Override any template-level instruction to "open from the website" when LI data is available. Rules: paraphrase, never paste post text verbatim; include the year for anything older than 12 months ("back in 2023") - never say "recently" or "last month" for stale signals; don't describe the recipient's own product back to them; one detail max - don't stuff multiple LI references into a single email; don't quote hiring posts or congratulatory reshares as if they were thought leadership.`

// Mirror of EMAIL_OUTPUT_CONTRACT in api/prompts/email.js. The output schema
// is a parser invariant - the /api/email route does JSON.parse on the LLM
// reply and expects `subject` + `body`, so this line is always appended to
// the system prompt regardless of what the template contains. Surfaced here
// so editors know they don't need to (and shouldn't) include it manually.
// KEEP IN SYNC.
const EMAIL_OUTPUT_CONTRACT = `Output strictly valid JSON: {"subject": string, "body": string}. No markdown fences, no commentary.`

export default function TemplatesPage() {
  const { workspace } = useWorkspace()
  // Active channel tab. Drives the list filter (we fetch all templates and
  // narrow client-side so swapping tabs is instant) and the default channel
  // for a freshly-created template. Email is the default tab since it's the
  // older / more populated catalog; LinkedIn shows the parallel LI set.
  const [activeChannel, setActiveChannel] = useState<TemplateChannel>('email')
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EmailTemplate | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  // Lookups for the editor dropdowns. Portfolio companies come from
  // /api/icps/portfolio-companies (so the user can only pick a company
  // that actually has ICPs). ICPs come from /api/icps and get filtered
  // by the currently-selected portfolio company in the editor.
  const [portfolioCompanies, setPortfolioCompanies] = useState<string[]>([])
  const [icps, setIcps] = useState<IcpOption[]>([])

  useEffect(() => {
    fetchPortfolioCompanies()
      .then((r) => setPortfolioCompanies(r.portfolioCompanies))
      .catch(() => { /* non-fatal */ })
    fetch(`${API_BASE}/api/icps`)
      .then((r) => r.json())
      .then((r) => {
        if (r?.success && Array.isArray(r.icps)) {
          setIcps(r.icps.map((i: any) => ({
            id: i.id,
            name: i.name,
            vertical: i.vertical || '',
            portfolioCompany: i.portfolioCompany || '',
          })))
        }
      })
      .catch(() => { /* non-fatal */ })
  }, [])

  // Channel filter is client-side - fetchAll() pulls every template once and
  // we narrow per render so swapping the Email/LinkedIn tab is instant.
  // Defends against older backends that don't echo `channel` (treats missing
  // as 'email', matching the backend default).
  const channelFiltered = useMemo(() => {
    return templates.filter((t) => (t.channel || 'email') === activeChannel)
  }, [templates, activeChannel])
  const visibleTemplates = useMemo(() => {
    if (!workspace) return channelFiltered
    const w = workspace.toLowerCase()
    return channelFiltered.filter((t) => (t.portfolioCompany || '').toLowerCase() === w)
  }, [channelFiltered, workspace])

  // Counts shown on the tab labels so the user knows whether the other tab
  // has anything to look at. Workspace-scoped to match what the user is
  // currently filtering on the page.
  const channelCounts = useMemo(() => {
    const w = workspace?.toLowerCase()
    const scoped = w
      ? templates.filter((t) => (t.portfolioCompany || '').toLowerCase() === w)
      : templates
    return {
      email: scoped.filter((t) => (t.channel || 'email') === 'email').length,
      linkedin: scoped.filter((t) => (t.channel || 'email') === 'linkedin').length,
    }
  }, [templates, workspace])

  const fetchAll = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchEmailTemplates()
      setTemplates(res.templates)
    } catch (e: any) {
      setError(e.message || 'Failed to load templates')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetchAll() }, [])

  const handleNew = () => {
    // Default new templates to the currently-active channel tab. The user
    // can still flip the field in the editor, but the common path is "I'm
    // on the LinkedIn tab and I want to add an LI template".
    setEditing({ ...EMPTY_TEMPLATE, portfolioCompany: workspace || '', channel: activeChannel })
    setIsNew(true)
  }
  const handleEdit = async (summary: EmailTemplateSummary) => {
    // Fetch the full record - the list endpoint trims systemPrompt to
    // keep the wire payload small.
    setError(null)
    try {
      const res = await fetchEmailTemplate(summary.id)
      setEditing({ ...res.template, sender: { ...res.template.sender } })
      setIsNew(false)
    } catch (e: any) {
      setError(e.message || 'Failed to load template')
    }
  }
  const handleClose = () => { setEditing(null); setIsNew(false) }

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    setError(null)
    try {
      if (isNew) await createEmailTemplate(editing)
      else await updateEmailTemplate(editing.id, editing)
      await fetchAll()
      setEditing(null)
      setIsNew(false)
    } catch (e: any) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (t: EmailTemplateSummary) => {
    if (!confirm(`Delete template "${t.name}"? This can't be undone.`)) return
    setError(null)
    try {
      await deleteEmailTemplate(t.id)
      await fetchAll()
      if (editing?.id === t.id) handleClose()
    } catch (e: any) {
      setError(e.message || 'Delete failed')
    }
  }

  return (
    <div className="relative h-full">
      <div className={`${GLASS} px-4 py-3 mb-4 flex items-center gap-3`}>
        {activeChannel === 'email'
          ? <Mail className="h-4 w-4 text-sky-500" />
          : <Linkedin className="h-4 w-4 text-sky-500" />}
        <span className="text-sm font-semibold">
          {activeChannel === 'email' ? 'Email Templates' : 'LinkedIn Templates'}
        </span>
        <span className="text-xs text-muted-foreground">
          {workspace
            ? <>{visibleTemplates.length} for <span className="font-medium text-foreground">{workspace}</span> · {templates.length} total across both channels</>
            : <>{visibleTemplates.length} defined · drives outbound {activeChannel === 'email' ? 'emails' : 'LinkedIn DMs'} per portfolio company</>}
        </span>
        <div className="flex-1" />
        <Button size="sm" onClick={handleNew}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New {activeChannel === 'email' ? 'Email' : 'LinkedIn'} Template
        </Button>
      </div>

      {/* Channel tab toggle - swaps the catalog between email + LinkedIn
          templates. Same storage backs both; the `channel` field on each
          template decides which tab it appears under. Counts on each label
          surface what's available in the other tab so the user doesn't
          forget there's a parallel set. */}
      <div className="mb-4 inline-flex rounded-md border border-border overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setActiveChannel('email')}
          className={cn(
            'px-3 py-1.5 inline-flex items-center gap-1.5 transition-colors',
            activeChannel === 'email'
              ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
              : 'text-muted-foreground hover:bg-muted/40',
          )}
        >
          <Mail className="h-3 w-3" />
          Email
          <span className="text-[10px] font-mono bg-muted/50 px-1 rounded">{channelCounts.email}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveChannel('linkedin')}
          className={cn(
            'px-3 py-1.5 border-l border-border inline-flex items-center gap-1.5 transition-colors',
            activeChannel === 'linkedin'
              ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
              : 'text-muted-foreground hover:bg-muted/40',
          )}
        >
          <Linkedin className="h-3 w-3" />
          LinkedIn
          <span className="text-[10px] font-mono bg-muted/50 px-1 rounded">{channelCounts.linkedin}</span>
        </button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/40 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Narrow list on the left, wide editor on the right. The editor
          holds the long system-prompt textarea and sender form so it gets
          the dominant column; the list is a compact picker rail. */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        <div className="space-y-2 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-100px)] overflow-y-auto pr-1">
          {loading && templates.length === 0 ? (
            <Card className={GLASS}>
              <CardContent className="py-8 text-center text-muted-foreground text-xs">
                <Loader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
                Loading templates…
              </CardContent>
            </Card>
          ) : visibleTemplates.length === 0 ? (
            <Card className={GLASS}>
              <CardContent className="py-8 text-center text-muted-foreground text-xs">
                {workspace
                  ? <>No templates yet for <span className="font-semibold">{workspace}</span>.</>
                  : <>No templates defined. Click "New Template" to create your first.</>}
              </CardContent>
            </Card>
          ) : (
            visibleTemplates.map((t) => {
              const active = editing?.id === t.id
              return (
                <Card
                  key={t.id}
                  className={`${GLASS} cursor-pointer transition hover:bg-white/65 dark:hover:bg-white/[0.06] ${active ? 'ring-2 ring-sky-500/60 bg-sky-500/[0.06]' : ''}`}
                  onClick={() => handleEdit(t)}
                >
                  <CardContent className="p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold truncate mb-0.5">{t.name}</h3>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {t.portfolioCompany && (
                            <Badge variant="secondary" className="text-[9px] py-0 px-1.5">{t.portfolioCompany}</Badge>
                          )}
                          <Badge variant="outline" className="text-[9px] uppercase py-0 px-1.5">{t.language}</Badge>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {t.sender.firstName}{t.sender.lastName ? ` ${t.sender.lastName}` : ''}
                          </span>
                        </div>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-red-600 dark:text-red-400 hover:bg-red-500/10 shrink-0"
                        title="Delete template"
                        onClick={(e) => { e.stopPropagation(); handleDelete(t) }}
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

        <Card className={GLASS}>
          <CardContent className="p-5">
            {!editing ? (
              <div className="text-center text-muted-foreground py-16">
                <Mail className="h-8 w-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm mb-1">No template open.</p>
                <p className="text-xs leading-relaxed">
                  Click a template in the list, or "New Template" to create one.
                </p>
              </div>
            ) : (
              <TemplateEditor
                template={editing}
                isNew={isNew}
                saving={saving}
                portfolioCompanies={portfolioCompanies}
                icps={icps}
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

function TemplateEditor({
  template,
  isNew,
  saving,
  portfolioCompanies,
  icps,
  onChange,
  onSave,
  onClose,
}: {
  template: EmailTemplate
  isNew: boolean
  saving: boolean
  portfolioCompanies: string[]
  icps: IcpOption[]
  onChange: (t: EmailTemplate) => void
  onSave: () => void
  onClose: () => void
}) {
  const updateSender = (key: keyof EmailTemplate['sender'], value: string) => {
    onChange({ ...template, sender: { ...template.sender, [key]: value } })
  }
  const updateField = <K extends keyof EmailTemplate>(key: K, value: EmailTemplate[K]) => {
    onChange({ ...template, [key]: value })
  }

  // ICPs available in the multi-select - narrowed to the chosen portfolio
  // company so the user can't bind a Bluebird template to a NedFox ICP.
  const eligibleIcps = template.portfolioCompany
    ? icps.filter((i) => i.portfolioCompany === template.portfolioCompany)
    : icps

  const toggleIcp = (icpId: string) => {
    const current = template.defaultForIcps || []
    const next = current.includes(icpId)
      ? current.filter((x) => x !== icpId)
      : [...current, icpId]
    onChange({ ...template, defaultForIcps: next })
  }

  // When portfolio company changes, drop ICP picks that don't belong to
  // the new company - keeps the data internally consistent.
  const handlePortfolioChange = (next: string) => {
    const stillValidIcps = (template.defaultForIcps || []).filter((id) => {
      const icp = icps.find((i) => i.id === id)
      return icp && icp.portfolioCompany === next
    })
    onChange({ ...template, portfolioCompany: next, defaultForIcps: stillValidIcps })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{isNew ? 'New Template' : `Edit · ${template.name || template.id}`}</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <Field label="ID" hint="lowercase, hyphens - used internally. Cannot be changed after create.">
        <Input
          value={template.id}
          onChange={(e) => updateField('id', e.target.value)}
          placeholder="e.g. bluebird-fazal"
          disabled={!isNew}
        />
      </Field>

      <Field label="Name" hint="Shown in the picker dropdown and on cards.">
        <Input
          value={template.name}
          onChange={(e) => updateField('name', e.target.value)}
          placeholder="e.g. Fazal - UK Direct"
        />
      </Field>

      <Field label="Portfolio Company" hint="Which Valsoft portfolio company this template represents. Drives which ICPs are pickable below.">
        <select
          value={template.portfolioCompany}
          onChange={(e) => handlePortfolioChange(e.target.value)}
          className="w-full text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
        >
          <option value="">- pick a company -</option>
          {portfolioCompanies.map((pc) => (
            <option key={pc} value={pc}>{pc}</option>
          ))}
          {/* Allow the picked value through even if it's not in the list
              (e.g. a legacy template whose company name has changed). */}
          {template.portfolioCompany && !portfolioCompanies.includes(template.portfolioCompany) && (
            <option value={template.portfolioCompany}>{template.portfolioCompany} (legacy)</option>
          )}
        </select>
      </Field>

      <Field label="Channel" hint="Email = used by /api/email + the Leads page; LinkedIn = used by /api/li-message. The LinkedIn channel template should be tuned for LinkedIn DMs (shorter, conversational, no email salutations) - the LI message generator picks templates filtered to this channel.">
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => updateField('channel', 'email')}
            className={cn(
              'px-3 py-1.5 inline-flex items-center gap-1.5 transition-colors',
              template.channel === 'email'
                ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40',
            )}
          >
            <Mail className="h-3 w-3" />
            Email
          </button>
          <button
            type="button"
            onClick={() => updateField('channel', 'linkedin')}
            className={cn(
              'px-3 py-1.5 border-l border-border inline-flex items-center gap-1.5 transition-colors',
              template.channel === 'linkedin'
                ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40',
            )}
          >
            <Linkedin className="h-3 w-3" />
            LinkedIn
          </button>
        </div>
      </Field>

      <Field label="Language" hint="The language the generated email will be written in (subject + body). Available via the {{language}} token inside the system prompt.">
        <select
          value={template.language}
          onChange={(e) => updateField('language', e.target.value)}
          className="w-full text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
        >
          {/* Anything stored on the template that isn't in our standard list
              passes through so legacy values (e.g. 2-letter codes from
              earlier seeds) don't get dropped on edit. */}
          {template.language && !LANGUAGE_OPTIONS.includes(template.language) && (
            <option value={template.language}>{template.language} (custom)</option>
          )}
          {LANGUAGE_OPTIONS.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>
      </Field>

      <Field
        label="ICPs this template applies to"
        hint={template.portfolioCompany
          ? `Click to toggle. Email Generation auto-selects this template when run for any of these ICPs. Only ICPs under ${template.portfolioCompany} are pickable.`
          : 'Pick a portfolio company above first - ICPs are scoped to the chosen company.'}
      >
        {eligibleIcps.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            {template.portfolioCompany
              ? `No ICPs defined for ${template.portfolioCompany} yet - create them on the ICPs page first.`
              : 'No portfolio company selected.'}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {eligibleIcps.map((icp) => {
              const isSel = (template.defaultForIcps || []).includes(icp.id)
              return (
                <button
                  key={icp.id}
                  type="button"
                  onClick={() => toggleIcp(icp.id)}
                  title={`${icp.name} · ${icp.vertical || 'no vertical'}`}
                  className={`px-2 py-1 rounded-md border text-[11px] leading-none transition-colors ${isSel
                    ? 'bg-sky-500/20 border-sky-500/60 text-sky-700 dark:text-sky-300 font-semibold'
                    : 'border-border text-muted-foreground hover:bg-muted/40'}`}
                >
                  {icp.name}
                </button>
              )
            })}
          </div>
        )}
      </Field>

      <div className={`${GLASS_SUBTLE} p-3 rounded-md border border-border/40 space-y-2.5`}>
        <div className="text-xs font-semibold flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-sky-500" />
          Sender persona
        </div>
        <Field label="First name" hint="Required - used in the signoff and {{sender.firstName}} token.">
          <Input
            value={template.sender.firstName}
            onChange={(e) => updateSender('firstName', e.target.value)}
            placeholder="Fazal"
          />
        </Field>
        <Field label="Last name">
          <Input
            value={template.sender.lastName || ''}
            onChange={(e) => updateSender('lastName', e.target.value)}
            placeholder="Khaishgi"
          />
        </Field>
        <Field label="Title">
          <Input
            value={template.sender.title || ''}
            onChange={(e) => updateSender('title', e.target.value)}
            placeholder="Group Managing Director"
          />
        </Field>
        <Field label="Company">
          <Input
            value={template.sender.company || ''}
            onChange={(e) => updateSender('company', e.target.value)}
            placeholder="Bluebird Auto Rental Software"
          />
        </Field>
        <Field label="Email">
          <Input
            value={template.sender.email || ''}
            onChange={(e) => updateSender('email', e.target.value)}
            placeholder="fazal@bluebird-arc.com"
          />
        </Field>
        <Field label="Signoff name" hint="Required - first-name as it appears at the bottom of the email.">
          <Input
            value={template.sender.signoff}
            onChange={(e) => updateSender('signoff', e.target.value)}
            placeholder="Fazal"
          />
        </Field>
      </div>

      <Field label="Voice / tone notes" hint='Short description of the email voice. Injected into the system prompt via the {{voice}} token if used.'>
        <Input
          value={template.voice}
          onChange={(e) => updateField('voice', e.target.value)}
          placeholder="Warm, professional, plain English. No bro-speak."
        />
      </Field>

      <Field label="System prompt" hint='The full instructions fed to GPT. Tokens: {{voice}}, {{language}}, {{sender.firstName}}, {{sender.title}}, {{sender.company}}. The JSON output contract is appended automatically - see the always-applied panel below.'>
        {/* Read-only "Always applied" panel for the parser-invariant JSON
            contract. The /api/email route does JSON.parse + reads subject
            and body off the result, so this line is hardcoded into every
            prompt regardless of what the template says. Surfaced here so
            editors know they don't need to (and shouldn't) include it. */}
        <div className="mb-2 rounded-md border border-border/40 bg-muted/30 p-2.5 text-[11px] leading-relaxed">
          <div className="font-semibold uppercase tracking-wide text-[9px] text-muted-foreground mb-1">
            Always appended (hardcoded, not editable)
          </div>
          <div className="text-muted-foreground font-mono">
            {EMAIL_OUTPUT_CONTRACT}
          </div>
        </div>
        {/* Fixed-height textarea with internal scroll. Without explicit
            min-h / max-h, browsers grow the box to fit content (or shrink
            to default rows), leaving the user unable to reach the bottom
            when content overflows. Cap at ~50vh so the editor doesn't
            push the save button below the fold, but let the user grow it
            with the drag handle if they want more breathing room. */}
        <textarea
          value={template.systemPrompt}
          onChange={(e) => updateField('systemPrompt', e.target.value)}
          className={`${GLASS_SUBTLE} w-full px-3 py-2 text-xs leading-relaxed font-mono resize-y min-h-[16rem] max-h-[50vh] overflow-y-auto`}
          placeholder="You write short outbound sales emails on behalf of …"
        />
      </Field>

      <Field
        label="How to use LinkedIn information (optional)"
        hint="Layered on top of the universal rules below. Free text - e.g. 'For Bluebird, lead with fleet-expansion or airport-branch posts; avoid booking-aggregator references.'"
      >
        {/* Read-only "Always applied" panel shows the universal rules that
            ship in every prompt. Surfaced here so template editors can
            see what's baked in and write portfolio-specific guidance that
            stacks on top instead of duplicating it. Kept in sync with
            LINKEDIN_UNIVERSAL_RULES in api/prompts/email.js. */}
        <div className="mb-2 rounded-md border border-border/40 bg-muted/30 p-2.5 text-[11px] leading-relaxed">
          <div className="font-semibold uppercase tracking-wide text-[9px] text-muted-foreground mb-1">
            Always applied (hardcoded, not editable)
          </div>
          <div className="text-muted-foreground">
            LinkedIn signals: {LINKEDIN_UNIVERSAL_RULES}.
          </div>
        </div>
        <textarea
          value={template.linkedinGuidance || ''}
          onChange={(e) => updateField('linkedinGuidance', e.target.value)}
          className={`${GLASS_SUBTLE} w-full px-3 py-2 text-xs leading-relaxed font-mono resize-y min-h-[6rem] max-h-[20vh] overflow-y-auto`}
          placeholder="Optional. Portfolio-specific guidance - gets appended to the LinkedIn signals block in the prompt."
        />
      </Field>

      <div className="flex items-center gap-2 pt-2">
        <Button size="sm" onClick={onSave} disabled={saving} className="flex-1">
          {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
          {isNew ? 'Create Template' : 'Save changes'}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
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
