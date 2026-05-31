// Pipeline page - paste a car rental URL → classify → leads → email.
// Three vertically-stacked sections that activate in sequence as the
// pipeline progresses. Each section can be re-run independently if the user
// wants to swap leads or regenerate the email.

import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  IconLink,
  IconLoader2,
  IconCheck,
  IconAlertTriangle,
  IconUsers,
  IconMail,
  IconCopy,
  IconRefresh,
  IconBrandLinkedin,
  IconWorld,
  IconClipboardCheck,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { GLASS } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  classifyUrl,
  fetchLeads,
  generateEmail,
  fetchEmailTemplates,
  suggestEmailTemplate,
  type Classification,
  type Lead,
  type GeneratedEmail,
  type EmailTemplateSummary,
} from '@/lib/api'
import { useWorkspace } from '@/context/workspace-context'

export default function PipelinePage() {
  const [url, setUrl] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()

  // The Sourcing page hands off a website URL via the hash fragment
  // (#prefill=<encoded-url>) when the user clicks "Send to Sales Agent".
  // Read it once on mount, prefill the input, and clear the hash so a
  // browser back-forward doesn't re-trigger a stale prefill.
  useEffect(() => {
    if (!window.location.hash) return
    const match = window.location.hash.match(/prefill=([^&]+)/)
    if (match) {
      try {
        const decoded = decodeURIComponent(match[1])
        if (decoded) setUrl(decoded)
      } catch { /* malformed - ignore */ }
      // Strip the hash without triggering a navigation.
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  const [classification, setClassification] = useState<Classification | null>(null)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [classifyLoading, setClassifyLoading] = useState(false)
  const [classifyError, setClassifyError] = useState<string | null>(null)
  // When the user arrives via My Accounts, we know the company is already
  // classified by an ICP - we skip the URL→Classify step and load the
  // stored classification + auto-progress to lead generation. This state
  // also drives the "Pre-loaded from My Accounts" banner in Step 1.
  const [fromAccount, setFromAccount] = useState<{ companyId: string; icpId: string; companyName: string } | null>(null)
  // Email template state. Templates drive sender persona + system prompt
  // - each portfolio company (Bluebird, Thermeon, NedFox) has its own.
  // Loaded once on mount; auto-suggested on the from-Accounts skip flow
  // so the rep lands with the right template pre-selected.
  const { workspace } = useWorkspace()
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([])
  const [activeTemplateId, setActiveTemplateId] = useState<string>('')

  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [leadsLoading, setLeadsLoading] = useState(false)
  const [leadsError, setLeadsError] = useState<string | null>(null)
  const [leadsWarnings, setLeadsWarnings] = useState<string[]>([])

  // Load the email-template catalog once on mount. The picker dropdown
  // narrows to the current workspace + the active classification's ICP
  // (when available) so the rep only sees templates that make sense.
  useEffect(() => {
    fetchEmailTemplates()
      .then((r) => setTemplates(r.templates))
      .catch(() => { /* non-fatal - picker stays empty, email gen falls back to default */ })
  }, [])

  // Templates available in the picker. Filtered by workspace (so a
  // NedFox rep doesn't see Bluebird templates by default). If the rep
  // wants to use a template from another portfolio company, they can
  // pick "All workspaces" via the workspace switcher - there's no
  // per-page override here to keep the picker uncluttered.
  const visibleTemplates = useMemo(() => {
    if (!workspace) return templates
    const w = workspace.toLowerCase()
    return templates.filter((t) => (t.portfolioCompany || '').toLowerCase() === w)
  }, [templates, workspace])

  // Resolved sender label for the email card header - pulls from the
  // active template if one is picked, else falls back to "Fazal" so the
  // legacy paste-classify flow still reads naturally.
  const activeTemplate = templates.find((t) => t.id === activeTemplateId)
  const senderLabel = activeTemplate
    ? `${activeTemplate.sender.firstName} ${activeTemplate.sender.lastName || ''}`.trim()
    : 'Fazal Khaishgi'

  // "Pre-classified from Accounts" skip flow. Triggered by URL query
  // params: /email?companyId=<id>&icp=<icpId>.
  //
  // What we do:
  //   1. Fetch the company by id (it already exists from Coverage)
  //   2. Pull its classification for the selected ICP (the same data the
  //      classifier originally produced) and inject it into the pipeline
  //      state - same shape as if the user had pasted a URL + clicked
  //      Classify.
  //   3. Auto-call lead lookup so the rep lands on Step 2 with leads
  //      already loading - saves a click and skips re-doing work.
  //
  // Query params are cleared after read so a browser back/forward or
  // share-of-URL doesn't re-trigger the skip flow stale.
  useEffect(() => {
    const skipCompanyId = searchParams.get('companyId')
    const skipIcpId = searchParams.get('icp')
    if (!skipCompanyId || !skipIcpId) return

    let cancelled = false
    setClassifyLoading(true)
    setClassifyError(null)
    setLeadsError(null)

    ;(async () => {
      try {
        const res = await fetch(`/api/companies/${encodeURIComponent(skipCompanyId)}`).then((r) => r.json())
        if (cancelled) return
        if (!res?.success || !res.company) throw new Error('Account not found - it may have been deleted.')
        const company = res.company
        const cls = (company.classifications && company.classifications[skipIcpId]) || company.classification
        if (!cls) throw new Error(`No classification for this account under ICP "${skipIcpId}". Run a sweep or reclassify first.`)

        // Hydrate as if classifyUrl had just returned. The vertical-gating
        // `isCarRental` flag is Bluebird-era - for non-rental ICPs we'd
        // otherwise fail the showLeadsCard check. Pre-classification from
        // Accounts means we ALREADY know this is a match for the ICP, so
        // we set isCarRental=true unconditionally to unlock leads.
        const hydrated: Classification = {
          ...cls,
          isCarRental: true,
          name: cls.name || cls.title || company.domain,
          domain: company.domain,
        }
        setClassification(hydrated)
        setCompanyId(company.id)
        setUrl(company.url || (company.domain ? `https://${company.domain}` : ''))
        setFromAccount({
          companyId: company.id,
          icpId: skipIcpId,
          companyName: hydrated.name || company.domain,
        })

        // Auto-pick the template bound to this ICP via defaultForIcps.
        // Fire-and-forget so the lead fetch isn't gated on this - if
        // there's no template for the ICP yet, the picker stays empty
        // and email gen falls back to the default Fazal template.
        suggestEmailTemplate({ icp: skipIcpId })
          .then((r) => { if (r.template && !cancelled) setActiveTemplateId(r.template.id) })
          .catch(() => { /* non-fatal */ })

        // Auto-fetch leads with the freshly-hydrated data. State updates
        // are async so we use local vars rather than reading state back.
        setLeadsLoading(true)
        try {
          const leadsRes = await fetchLeads({
            companyName: hydrated.name || company.domain,
            domain: company.domain,
            limit: 3,
            companyId: company.id,
          })
          if (!cancelled) {
            setLeads(leadsRes.people)
            setLeadsWarnings(leadsRes.warnings || [])
          }
        } catch (leadsErr: any) {
          if (!cancelled) setLeadsError(leadsErr.message || 'Lead search failed')
        } finally {
          if (!cancelled) setLeadsLoading(false)
        }
      } catch (e: any) {
        if (!cancelled) setClassifyError(e.message || 'Failed to load account')
      } finally {
        if (!cancelled) setClassifyLoading(false)
      }
    })()

    // Drop the params so a refresh doesn't replay the skip flow with a
    // potentially stale id (e.g. user already finished sending the email
    // and reloaded - they should land on the empty pipeline).
    setSearchParams({}, { replace: true })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [activeLead, setActiveLead] = useState<Lead | null>(null)
  const [email, setEmail] = useState<GeneratedEmail | null>(null)
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleClassify() {
    if (!url.trim() || classifyLoading) return
    // Reset the entire downstream pipeline - classifying a new URL is
    // effectively starting over, and stale leads/email from a prior run
    // would be confusing.
    setClassifyLoading(true)
    setClassifyError(null)
    setClassification(null)
    setCompanyId(null)
    setLeads(null)
    setLeadsError(null)
    setLeadsWarnings([])
    setActiveLead(null)
    setEmail(null)
    setEmailError(null)

    try {
      const res = await classifyUrl(url.trim())
      setClassification(res.classification)
      setCompanyId(res.companyId || null)
    } catch (err: any) {
      setClassifyError(err.message || 'Classification failed')
    } finally {
      setClassifyLoading(false)
    }
  }

  async function handleFetchLeads() {
    if (!classification || leadsLoading) return
    setLeadsLoading(true)
    setLeadsError(null)
    setLeads(null)
    setLeadsWarnings([])
    setActiveLead(null)
    setEmail(null)

    try {
      const res = await fetchLeads({
        companyName: classification.name || '',
        domain: classification.domain || '',
        limit: 3,
        companyId: companyId || undefined,
      })
      setLeads(res.people)
      setLeadsWarnings(res.warnings || [])
    } catch (err: any) {
      setLeadsError(err.message || 'Lead search failed')
    } finally {
      setLeadsLoading(false)
    }
  }

  async function handleGenerateEmail(lead: Lead) {
    if (!classification || emailLoading) return
    setActiveLead(lead)
    setEmail(null)
    setEmailLoading(true)
    setEmailError(null)
    setCopied(false)

    try {
      const res = await generateEmail({
        classification,
        lead,
        companyId: companyId || undefined,
        // Template takes priority over the legacy senderId field. The
        // backend falls back to the Bluebird-Fazal template if neither
        // is provided, preserving old behaviour for paste-classify flows.
        templateId: activeTemplateId || undefined,
        icpId: fromAccount?.icpId,
        senderId: activeTemplateId ? undefined : 'fazal',
      })
      setEmail(res.email)
      // Server may have enriched the lead (revealed email + LinkedIn) as
      // part of the email-gen flow. Swap the enriched copy back into our
      // leads list so the row's badge updates and the next click on the
      // same row skips re-enrichment.
      if (res.lead && leads) {
        const updatedLeads = leads.map(l => (l.apolloId === res.lead.apolloId ? res.lead : l))
        setLeads(updatedLeads)
        setActiveLead(res.lead)
      }
      // Surface enrichment warnings (e.g. Apollo credits exhausted) if any.
      if (res.warnings?.length) {
        setLeadsWarnings([...leadsWarnings, ...res.warnings])
      }
    } catch (err: any) {
      setEmailError(err.message || 'Email generation failed')
    } finally {
      setEmailLoading(false)
    }
  }

  function handleCopyEmail() {
    if (!email) return
    const text = `Subject: ${email.subject}\n\n${email.body}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const showLeadsCard = !!classification && classification.isCarRental

  return (
    // Full-bleed: no max-width and no mx-auto, so the three step cards
    // span edge-to-edge between the sidebar and the right side of the
    // viewport. The Main wrapper still provides the px-6/8 padding off
    // the sidebar, so cards aren't kissing the edges.
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sales Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {fromAccount
            ? <>Drafting outreach for <span className="font-semibold text-foreground">{fromAccount.companyName}</span> - classification pre-loaded from My Accounts, finding decision-makers now.</>
            : <>Paste a car rental website URL - we'll classify the business, find decision-makers, and draft an outreach email from Fazal.</>}
        </p>
      </div>

      {/* ─── Pipeline layout: 2 columns on desktop ────────────────────────
          Left: Report (full viewport height, narrower).
          Right: Leads (top, scrolls) + Email (bottom, long-form, gets ~2x
                 the height of Leads). The right column is a vertical flex
                 so the cards split the available height proportionally
                 instead of fighting for space.
          Stacks vertically on mobile/tablet (default). */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-6 lg:h-[calc(100vh-180px)]">

      {/* ─── Step 1: URL → classify (or "From My Accounts" if skipped) ── */}
      <Card className={cn(GLASS, 'bb-card-in', 'lg:h-full lg:flex lg:flex-col lg:min-h-0')}>
        <CardHeader>
          {fromAccount ? (
            <>
              <CardTitle className="flex items-center gap-2">
                <IconClipboardCheck className="h-5 w-5 text-emerald-500" />
                Pre-classified · From My Accounts
              </CardTitle>
              <CardDescription>
                Classification already complete from Coverage - skipping the URL analyze step. The original GPT verdict for
                this ICP is shown below; Step 2 is auto-fetching decision-makers now.
              </CardDescription>
            </>
          ) : (
            <>
              <CardTitle className="flex items-center gap-2">
                <IconLink className="h-5 w-5" /> Step 1 · Paste URL
              </CardTitle>
              <CardDescription>Any car rental company website.</CardDescription>
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-3 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
          {fromAccount ? (
            // Inline "pre-loaded" banner. Shows the account context (which
            // company / which ICP it was classified under) so the rep knows
            // exactly which lead they're working on, plus a quick link back
            // to My Accounts in case they want to re-review or pick a
            // different account.
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs flex items-center gap-2 flex-wrap">
              <span className="text-emerald-700 dark:text-emerald-300 font-semibold">✓ Loaded</span>
              <span className="text-muted-foreground truncate">
                {fromAccount.companyName} · ICP <code className="font-mono">{fromAccount.icpId}</code>
              </span>
              <span className="flex-1" />
              <a
                href="/accounts"
                className="text-sky-600 dark:text-sky-400 hover:underline"
              >
                ← back to My Accounts
              </a>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                placeholder="https://example-rentals.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleClassify()}
                disabled={classifyLoading}
              />
              <Button onClick={handleClassify} disabled={!url.trim() || classifyLoading}>
                {classifyLoading ? (
                  <>
                    <IconLoader2 className="h-4 w-4 animate-spin" />
                    Classifying…
                  </>
                ) : (
                  'Analyze'
                )}
              </Button>
            </div>
          )}
          {classifyError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <IconAlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>{classifyError}</div>
            </div>
          )}
          {classifyLoading && fromAccount && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconLoader2 className="h-4 w-4 animate-spin" />
              Loading classification…
            </div>
          )}
          {classification && <ClassificationCard classification={classification} />}
        </CardContent>
      </Card>

      {/* ─── Right column: Leads (top) + Email (bottom) ──────────────────
          On mobile `display: contents` makes Step 2 and Step 3 act as
          direct grid children so they stack with the rest. On desktop
          this becomes a vertical flex column inside the right grid cell
          so Leads + Email split the available height — Email gets ~2x
          the height since it's the long-form panel the rep actually
          reads/edits. */}
      <div className="contents lg:flex lg:flex-col lg:gap-6 lg:min-h-0">

      {/* ─── Step 2: leads ─────────────────────────────────────────────── */}
      {/* Always-render so the slot stays in place during the pipeline.
          Placeholder while disabled, real content once a URL has been
          classified. Internal scroll handles long lead lists. */}
      {!showLeadsCard ? (
        <Card className={cn(GLASS, 'bb-card-in', 'opacity-60', 'lg:flex-1 lg:flex lg:flex-col lg:min-h-0')} style={{ animationDelay: '80ms' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-muted-foreground">
              <IconUsers className="h-5 w-5" /> Step 2 · Decision-makers
            </CardTitle>
            <CardDescription>
              {classification && !classification.isCarRental
                ? 'This URL did not classify as a car rental - try a different site.'
                : 'Analyze a URL on the left to find decision-makers via Apollo.'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className={cn(GLASS, 'bb-card-in', 'lg:flex-1 lg:flex lg:flex-col lg:min-h-0')} style={{ animationDelay: '80ms' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconUsers className="h-5 w-5" /> Step 2 · Decision-makers
            </CardTitle>
            <CardDescription>
              Top contacts at <span className="font-medium">{classification?.name || classification?.domain}</span> via Apollo, ranked by seniority.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
            {!leads && !leadsLoading && (
              <Button onClick={handleFetchLeads} variant="outline">
                Find decision-makers
              </Button>
            )}
            {leadsLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <IconLoader2 className="h-4 w-4 animate-spin" />
                Searching Apollo…
              </div>
            )}
            {leadsError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <IconAlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>{leadsError}</div>
              </div>
            )}
            {leadsWarnings.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                {leadsWarnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
            {leads && leads.length === 0 && (
              <div className="text-sm text-muted-foreground">
                No decision-makers found in Apollo for this domain.
              </div>
            )}
            {leads && leads.length > 0 && (
              <div className="space-y-2">
                {leads.map((lead, i) => (
                  <LeadRow
                    key={lead.apolloId || i}
                    lead={lead}
                    isActive={activeLead?.apolloId === lead.apolloId}
                    onGenerate={() => handleGenerateEmail(lead)}
                    disabled={emailLoading && activeLead?.apolloId !== lead.apolloId}
                  />
                ))}
              </div>
            )}
            {leads && (
              <div className="pt-1">
                <Button variant="ghost" size="sm" onClick={handleFetchLeads}>
                  <IconRefresh className="h-3 w-3" /> Re-run search
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Step 3: email ─────────────────────────────────────────────── */}
      {/* Always-render so the grid keeps three columns. Real card once a
          lead has been picked; placeholder until then. */}
      {!showLeadsCard || !activeLead ? (
        <Card className={cn(GLASS, 'bb-card-in', 'opacity-60', 'lg:flex-[2] lg:flex lg:flex-col lg:min-h-0')} style={{ animationDelay: '160ms' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-muted-foreground">
              <IconMail className="h-5 w-5" /> Step 3 · Outreach email
            </CardTitle>
            <CardDescription>
              {!showLeadsCard
                ? 'Pick a lead in step 2 to draft an email.'
                : 'Click "Reveal & generate" or "Generate email" on a lead to draft the outreach.'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className={cn(GLASS, 'bb-card-in', 'lg:flex-[2] lg:flex lg:flex-col lg:min-h-0')} style={{ animationDelay: '160ms' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconMail className="h-5 w-5" /> Step 3 · Outreach email
            </CardTitle>
            <CardDescription>
              From {senderLabel} to{' '}
              <span className="font-medium">
                {activeLead.firstName} {activeLead.lastName || ''}
              </span>
              {activeLead.email && <span className="text-xs text-muted-foreground"> · {activeLead.email}</span>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
            {/* Template picker - drives sender persona + system prompt.
                When the rep arrives from My Accounts, the auto-suggest
                pre-fills this; otherwise they can pick before generating
                or change between regenerations. Filtered by workspace so
                a NedFox rep doesn't see Bluebird templates by default. */}
            {visibleTemplates.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">Template</label>
                <select
                  value={activeTemplateId}
                  onChange={(e) => setActiveTemplateId(e.target.value)}
                  className="text-xs border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark] flex-1"
                  disabled={emailLoading}
                >
                  <option value="">Default (Fazal - Bluebird)</option>
                  {visibleTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.portfolioCompany} · {t.language}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {emailLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <IconLoader2 className="h-4 w-4 animate-spin" />
                Generating email…
              </div>
            )}
            {emailError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <IconAlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>{emailError}</div>
              </div>
            )}
            {email && (
              <div className="space-y-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Subject</div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium">
                    {email.subject}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Body</div>
                  <textarea
                    value={email.body}
                    onChange={(e) => setEmail({ ...email, body: e.target.value })}
                    className="min-h-[180px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm font-mono leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleCopyEmail} size="sm">
                    <IconCopy className="h-3 w-3" />
                    {copied ? 'Copied!' : 'Copy to clipboard'}
                  </Button>
                  <Button onClick={() => handleGenerateEmail(activeLead)} size="sm" variant="outline">
                    <IconRefresh className="h-3 w-3" /> Regenerate
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      </div>{/* /right-column flex wrapper */}
      </div>{/* /pipeline grid */}
    </div>
  )
}

function ClassificationCard({ classification }: { classification: Classification }) {
  const isCarRental = classification.isCarRental
  const confidenceVariant: 'success' | 'warning' | 'destructive' =
    classification.confidence === 'high' ? 'success' : classification.confidence === 'medium' ? 'warning' : 'destructive'

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-bold">{classification.name || 'Unknown company'}</h3>
            {isCarRental ? (
              <Badge variant="success">
                <IconCheck className="h-3 w-3" /> Car rental
              </Badge>
            ) : (
              <Badge variant="destructive">Not a car rental</Badge>
            )}
            {isCarRental && classification.isIndependent && (
              <Badge variant="secondary">Independent</Badge>
            )}
            <Badge variant={confidenceVariant}>{classification.confidence} confidence</Badge>
          </div>
          {classification.tagline && (
            <p className="text-sm text-muted-foreground mt-1">{classification.tagline}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Field label="Location" value={[classification.city, classification.country].filter(Boolean).join(', ') || '-'} />
        <Field label="Domain" value={classification.domain || '-'} />
        <Field label="Languages" value={classification.languages?.join(', ') || '-'} />
        <Field
          label="Online booking"
          value={classification.hasOnlineBooking ? 'Yes' : 'No / unclear'}
        />
        <Field label="Fleet" value={classification.fleetSizeHint || '-'} />
        <Field label="Vehicle types" value={classification.fleetVehicleTypes?.join(', ') || '-'} />
        {classification.phone && <Field label="Phone" value={classification.phone} />}
        {classification.email && <Field label="Email" value={classification.email} />}
      </div>

      {classification.signals && classification.signals.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Signals</div>
            <ul className="text-xs space-y-1 list-disc list-inside">
              {classification.signals.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-medium truncate">{value}</div>
    </div>
  )
}

function LeadRow({
  lead,
  isActive,
  onGenerate,
  disabled,
}: {
  lead: Lead
  isActive: boolean
  onGenerate: () => void
  disabled: boolean
}) {
  const fullName = `${lead.firstName} ${lead.lastName || ''}`.trim() || '(unknown)'
  const isEnriched = !!lead.enriched

  // Button label communicates the cost: "Reveal & generate" warns the user
  // that this click will spend an Apollo credit on this person, while
  // "Generate email" / "Regenerate" indicates the lead is already enriched
  // and only OpenAI is hit.
  let buttonLabel = 'Reveal & generate'
  if (isActive) buttonLabel = 'Regenerate'
  else if (isEnriched) buttonLabel = 'Generate email'

  return (
    <div
      className={`flex items-center gap-3 rounded-md border p-3 transition-colors ${
        isActive ? 'border-primary bg-primary/5' : ''
      }`}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-bold">
        {lead.firstName?.[0] || '?'}
        {lead.lastName?.[0] || ''}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{fullName}</span>
          {isEnriched && (
            <Badge variant="success" className="text-[9px] px-1.5 py-0">
              <IconCheck className="h-2.5 w-2.5" /> Enriched
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">{lead.title || '-'}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground mt-0.5">
          {lead.email && (
            <span className="flex items-center gap-1">
              <IconWorld className="h-3 w-3" />
              {lead.email}
              {lead.emailStatus === 'verified' && <span className="text-emerald-600">✓</span>}
            </span>
          )}
          {!lead.email && lead.hasEmail && (
            <span className="italic">Email hidden - reveal on email-gen</span>
          )}
          {lead.linkedinUrl && (
            <a
              href={lead.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-foreground"
            >
              <IconBrandLinkedin className="h-3 w-3" /> LinkedIn
            </a>
          )}
        </div>
      </div>
      <Button size="sm" variant={isActive ? 'default' : 'outline'} onClick={onGenerate} disabled={disabled}>
        <IconMail className="h-3 w-3" />
        {buttonLabel}
      </Button>
    </div>
  )
}
