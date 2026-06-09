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
  IconPhone,
  IconCircleCheck,
  IconCircleX,
  IconRotateClockwise,
  IconChevronDown,
  IconChevronUp,
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
import { Markdown } from '@/components/ui/markdown'
import { GLASS } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  classifyUrl,
  overrideClassification,
  fetchLeads,
  generateEmail,
  fetchEmailTemplates,
  suggestEmailTemplate,
  enrichLeadPhone,
  submitReview,
  clearReview,
  type Classification,
  type Lead,
  type GeneratedEmail,
  type EmailTemplateSummary,
  type ScrapedContacts,
} from '@/lib/api'
import { API_BASE } from '@/lib/api-base'
import { useWorkspace } from '@/context/workspace-context'
import { useAccountsCount } from '@/context/accounts-count-context'

// Canned reject reasons - mirrors the list on the Accounts page so the
// Sales Agent's bottom-of-page review writes the same slugs (clean reject
// analytics later). Free-text note rides alongside for nuance.
const REJECT_REASONS = [
  { value: 'not-actually-this-vertical', label: 'Not actually this vertical' },
  { value: 'too-small', label: 'Too small / hobbyist' },
  { value: 'too-large', label: 'Too large / national chain' },
  { value: 'wrong-geography', label: 'Wrong geography' },
  { value: 'already-customer', label: 'Already a customer of competitor' },
  { value: 'closed-or-dormant', label: 'Closed / dormant / out of business' },
  { value: 'pure-ecommerce', label: 'Pure e-commerce, no physical store' },
  { value: 'wrong-business-model', label: 'Wrong business model (e.g. franchise)' },
  { value: 'duplicate', label: 'Duplicate / already in our pipeline' },
  { value: 'other', label: 'Other (see note)' },
] as const

// Trimmed ICP shape for the Sales Agent's classify-against picker.
interface IcpOption {
  id: string
  name: string
  vertical: string
  portfolioCompany: string
}

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
  // ICP picker. Analyze always classifies against ONE chosen ICP - the
  // dropdown starts empty and the Analyze button is greyed out until the
  // rep intentionally picks one. `activeIcpId` is the ICP the current
  // classification was actually run under (drives email-gen + override).
  const [icps, setIcps] = useState<IcpOption[]>([])
  const [selectedIcpId, setSelectedIcpId] = useState('')
  const [activeIcpId, setActiveIcpId] = useState<string | null>(null)
  // True when the latest classify reused a cached scrape (no Firecrawl call).
  const [fromCache, setFromCache] = useState(false)
  // True when the verdict + report were served from a prior stored result
  // for this ICP (no scrape, no GPT). Drives the "Re-classify" button.
  const [fromStored, setFromStored] = useState(false)
  // Drives the "not qualified" override popup. Set when a classify comes
  // back is_match:false so the rep can skip / try another ICP / override.
  const [overridePrompt, setOverridePrompt] = useState<{ reason: string; companyId: string | null; icpId: string } | null>(null)
  const [overriding, setOverriding] = useState(false)
  // Sales-rep decision for a from-Accounts company (the Confirm/Reject bar
  // at the bottom of the page). Mirrors the Accounts page review lanes;
  // initialized from the company's stored review on load so a prior
  // decision shows as already-made.
  const [reviewDecision, setReviewDecision] = useState<'confirmed' | 'rejected' | null>(null)
  const [reviewReason, setReviewReason] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState<string | null>(null)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  // Contacts harvested from the scraped site (emails/phones/LinkedIn) -
  // returned by /api/classify. A free fallback to Apollo: often the only
  // reachable contact for a tiny independent.
  const [contacts, setContacts] = useState<ScrapedContacts | null>(null)
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
  // Sidebar "My Accounts" pending pill - refreshed after a confirm/reject so
  // the count updates instantly instead of waiting for its poll.
  const { refresh: refreshAccountsCount } = useAccountsCount()
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([])
  const [activeTemplateId, setActiveTemplateId] = useState<string>('')

  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [leadsLoading, setLeadsLoading] = useState(false)
  const [leadsError, setLeadsError] = useState<string | null>(null)
  const [leadsWarnings, setLeadsWarnings] = useState<string[]>([])
  // Per-row phone-enrich state. Tracks which apolloIds are mid-flight and
  // which came back empty (Apollo had no phone on file). Same shape as the
  // Leads-page version.
  const [phoneEnriching, setPhoneEnriching] = useState<Set<string>>(new Set())
  const [phoneEmpty, setPhoneEmpty] = useState<Record<string, true>>({})
  const [phoneError, setPhoneError] = useState<Record<string, string>>({})

  // Phone-only re-check on a single lead. Same Apollo call as the main
  // Enrich, but only the phone field is persisted server-side. Splices the
  // updated lead back into `leads` so the row updates without a refetch.
  async function handleGetPhone(lead: Lead) {
    if (!lead.apolloId || !companyId) return
    const key = lead.apolloId
    setPhoneEnriching(prev => { const next = new Set(prev); next.add(key); return next })
    setPhoneEmpty(prev => { const { [key]: _drop, ...rest } = prev; return rest })
    setPhoneError(prev => { const { [key]: _drop, ...rest } = prev; return rest })
    try {
      const res = await enrichLeadPhone(companyId, lead.apolloId)
      setLeads(prev => prev ? prev.map(l => l.apolloId === key ? { ...l, ...res.lead } : l) : prev)
      if (!res.phoneFound) setPhoneEmpty(prev => ({ ...prev, [key]: true }))
    } catch (err: any) {
      setPhoneError(prev => ({ ...prev, [key]: err.message || 'Phone enrich failed' }))
    } finally {
      setPhoneEnriching(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  // Load the email-template catalog once on mount. The picker dropdown
  // narrows to the current workspace + the active classification's ICP
  // (when available) so the rep only sees templates that make sense.
  useEffect(() => {
    fetchEmailTemplates()
      .then((r) => setTemplates(r.templates))
      .catch(() => { /* non-fatal - picker stays empty, email gen falls back to default */ })
  }, [])

  // Load the ICP catalog for the "classify against" picker. Trimmed shape
  // (id/name/vertical/portfolioCompany) is all the dropdown needs.
  useEffect(() => {
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
      .catch(() => { /* non-fatal - picker stays empty, Analyze stays disabled */ })
  }, [])

  // ICPs the picker offers, narrowed to the active workspace (so a NedFox
  // rep doesn't have to scroll past Bluebird ICPs). When no workspace is
  // set ("All Companies"), every ICP shows.
  const visibleIcps = useMemo(() => {
    if (!workspace) return icps
    const w = workspace.toLowerCase()
    return icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === w)
  }, [icps, workspace])

  // Friendly name for whichever ICP the current classification ran under -
  // used in the override popup + classification card.
  const activeIcpName = icps.find((i) => i.id === activeIcpId)?.name || activeIcpId || ''

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
        const res = await fetch(`${API_BASE}/api/companies/${encodeURIComponent(skipCompanyId)}`).then((r) => r.json())
        if (cancelled) return
        if (!res?.success || !res.company) throw new Error('Account not found - it may have been deleted.')
        const company = res.company
        const cls = (company.classifications && company.classifications[skipIcpId]) || company.classification
        if (!cls) throw new Error(`No classification for this account under ICP "${skipIcpId}". Run a sweep or reclassify first.`)

        // Hydrate as if classifyUrl had just returned. Pre-classification
        // from Accounts means we ALREADY know this is a match for the ICP,
        // so we force is_match=true to unlock Step 2 (leads) regardless of
        // the stored verdict shape.
        const hydrated: Classification = {
          ...cls,
          is_match: true,
          name: cls.name || cls.title || company.domain,
          domain: company.domain,
        }
        setClassification(hydrated)
        setCompanyId(company.id)
        setContacts(company.scrapedContacts || null)
        setActiveIcpId(skipIcpId)
        setSelectedIcpId(skipIcpId)
        setUrl(company.url || (company.domain ? `https://${company.domain}` : ''))
        setFromAccount({
          companyId: company.id,
          icpId: skipIcpId,
          companyName: hydrated.name || company.domain,
        })

        // Seed the bottom-of-page review bar from any existing decision so a
        // previously confirmed/rejected account shows its state (with Undo)
        // rather than fresh Confirm/Reject buttons.
        const existingReview = company.reviews?.[skipIcpId]
        setReviewDecision(existingReview?.decision || null)
        setReviewReason(existingReview?.reason || null)
        setReviewNote(existingReview?.note || null)
        setRejectOpen(false)
        setReviewError(null)

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

  async function handleClassify(force = false) {
    // Analyze always runs against an intentionally-picked ICP. Bail if no
    // URL or no ICP (the button is also disabled in this state).
    if (!url.trim() || !selectedIcpId || classifyLoading) return
    // Reset the entire downstream pipeline - classifying a new URL is
    // effectively starting over, and stale leads/email from a prior run
    // would be confusing.
    setClassifyLoading(true)
    setClassifyError(null)
    setClassification(null)
    setCompanyId(null)
    setContacts(null)
    setFromCache(false)
    setFromStored(false)
    setOverridePrompt(null)
    setLeads(null)
    setLeadsError(null)
    setLeadsWarnings([])
    setActiveLead(null)
    setEmail(null)
    setEmailError(null)
    setActiveIcpId(selectedIcpId)

    try {
      const res = await classifyUrl(url.trim(), selectedIcpId, force)
      setClassification(res.classification)
      setCompanyId(res.companyId || null)
      setContacts(res.contacts || null)
      setFromCache(!!res.fromCache)
      setFromStored(!!res.fromStored)
      // Not qualified for this ICP → surface the override popup so the rep
      // can skip, try another ICP, or override to qualified. A reject is a
      // normal outcome, not an error.
      if (res.classification?.is_match === false) {
        setOverridePrompt({
          reason: res.classification.reason || 'The classifier marked this company as not a fit for the selected ICP.',
          companyId: res.companyId || null,
          icpId: selectedIcpId,
        })
      }
    } catch (err: any) {
      setClassifyError(err.message || 'Classification failed')
    } finally {
      setClassifyLoading(false)
    }
  }

  // ─── Not-qualified popup actions ──────────────────────────────────────
  // Override: persist is_match=true for this ICP, flip the local
  // classification to qualified (unlocking Step 2), and close the popup.
  async function handleOverride() {
    if (!overridePrompt) return
    if (!overridePrompt.companyId) {
      // No persisted company (rare - persist failed). Flip locally only.
      setClassification((prev) => (prev ? { ...prev, is_match: true, overridden: true } : prev))
      setOverridePrompt(null)
      return
    }
    setOverriding(true)
    try {
      await overrideClassification(overridePrompt.companyId, overridePrompt.icpId)
      setClassification((prev) => (prev ? { ...prev, is_match: true, overridden: true } : prev))
      setOverridePrompt(null)
    } catch (err: any) {
      setClassifyError(err.message || 'Override failed')
    } finally {
      setOverriding(false)
    }
  }

  // Try another ICP: dismiss the popup, clear the rejected verdict, and
  // reset the picker so the rep must intentionally pick a different ICP.
  function handleTryAnotherIcp() {
    setOverridePrompt(null)
    setClassification(null)
    setCompanyId(null)
    setContacts(null)
    setFromCache(false)
    setActiveIcpId(null)
    setSelectedIcpId('')
  }

  // Skip: dismiss the popup but leave the rejected verdict on screen so the
  // rep can still read the reason / report.
  function handleSkip() {
    setOverridePrompt(null)
  }

  // ─── Account review (Confirm / Reject / Undo) ─────────────────────────
  // Only meaningful in the from-Accounts flow. Writes the same per-ICP
  // review the Accounts page does, then nudges the sidebar pill to recount.
  async function handleConfirmAccount() {
    if (!fromAccount || reviewSubmitting) return
    setReviewSubmitting(true)
    setReviewError(null)
    try {
      await submitReview(fromAccount.companyId, fromAccount.icpId, { decision: 'confirmed' })
      setReviewDecision('confirmed')
      setReviewReason(null)
      setReviewNote(null)
      setRejectOpen(false)
      refreshAccountsCount()
    } catch (err: any) {
      setReviewError(err.message || 'Failed to confirm')
    } finally {
      setReviewSubmitting(false)
    }
  }

  async function handleRejectAccount(reason: string, note: string) {
    if (!fromAccount || reviewSubmitting) return
    setReviewSubmitting(true)
    setReviewError(null)
    try {
      await submitReview(fromAccount.companyId, fromAccount.icpId, { decision: 'rejected', reason, note })
      setReviewDecision('rejected')
      setReviewReason(reason)
      setReviewNote(note || null)
      setRejectOpen(false)
      refreshAccountsCount()
    } catch (err: any) {
      setReviewError(err.message || 'Failed to reject')
    } finally {
      setReviewSubmitting(false)
    }
  }

  async function handleUndoReview() {
    if (!fromAccount || reviewSubmitting) return
    setReviewSubmitting(true)
    setReviewError(null)
    try {
      await clearReview(fromAccount.companyId, fromAccount.icpId)
      setReviewDecision(null)
      setReviewReason(null)
      setReviewNote(null)
      refreshAccountsCount()
    } catch (err: any) {
      setReviewError(err.message || 'Failed to undo')
    } finally {
      setReviewSubmitting(false)
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
        icpId: fromAccount?.icpId || activeIcpId || undefined,
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

  const showLeadsCard = !!classification && classification.is_match === true

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
            : <>Pick an ICP, paste a company website URL - we'll classify the business against that ICP, find decision-makers, and draft an outreach email.</>}
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
                <IconLink className="h-5 w-5" /> Step 1 · Pick ICP & analyze
              </CardTitle>
              <CardDescription>Pick an ICP, then analyze any company website against it.</CardDescription>
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
            <div className="space-y-2">
              {/* ICP picker - empty by default. Analyze stays disabled until
                  the rep intentionally picks an ICP, so every classify runs
                  against a specific, chosen ICP (never a generic guess). */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">ICP</label>
                <select
                  value={selectedIcpId}
                  onChange={(e) => setSelectedIcpId(e.target.value)}
                  className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-2 [color-scheme:light_dark] flex-1"
                  disabled={classifyLoading}
                >
                  <option value="">Select an ICP to classify against…</option>
                  {visibleIcps.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}{i.vertical ? ` · ${i.vertical}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="https://example-company.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleClassify()}
                  disabled={classifyLoading}
                />
                <Button onClick={() => handleClassify()} disabled={!url.trim() || !selectedIcpId || classifyLoading}>
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
              {!selectedIcpId && (
                <p className="text-[11px] text-muted-foreground">
                  Pick an ICP above to enable Analyze - the company is classified against that ICP's criteria.
                </p>
              )}
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
          {classification && (
            <ClassificationCard
              classification={classification}
              icpName={activeIcpName}
              fromCache={fromCache}
              fromStored={fromStored}
              onReclassify={fromStored && !classifyLoading ? () => handleClassify(true) : undefined}
              onReopenOverride={
                classification.is_match === false && !overridePrompt
                  ? () => setOverridePrompt({
                      reason: classification.reason || 'The classifier marked this company as not a fit for the selected ICP.',
                      companyId,
                      icpId: activeIcpId || '',
                    })
                  : undefined
              }
            />
          )}
          {classification && <ScrapedContactsBlock contacts={contacts} />}
        </CardContent>
      </Card>

      {/* ─── Right column: Leads (top) + Email (bottom) ──────────────────
          On mobile `display: contents` makes Step 2 and Step 3 act as
          direct grid children so they stack with the rest. On desktop
          this becomes a vertical flex column inside the right grid cell
          so Leads + Email split the available height - Email gets ~2x
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
              {classification && classification.is_match === false
                ? "This company didn't qualify for the selected ICP - override it or try another ICP on the left."
                : 'Pick an ICP and analyze a URL on the left to find decision-makers via Apollo.'}
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
                    enrichingPhone={!!lead.apolloId && phoneEnriching.has(lead.apolloId)}
                    onGetPhone={() => handleGetPhone(lead)}
                    phoneEmpty={!!lead.apolloId && !!phoneEmpty[lead.apolloId]}
                    phoneError={lead.apolloId ? phoneError[lead.apolloId] || null : null}
                    canGetPhone={!!lead.apolloId && !!companyId}
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

      {/* ─── Decision bar (from My Accounts only) ──────────────────────────
          Once a rep has worked an account through the Sales Agent, they
          confirm or reject it right here without bouncing back to the
          Accounts page. Writes the same per-ICP review. Only shown in the
          from-Accounts flow - a paste-classify URL has no account to mark. */}
      {fromAccount && (
        <Card className={cn(GLASS, 'bb-card-in')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <IconClipboardCheck className="h-5 w-5 text-emerald-500" />
              Decision · {fromAccount.companyName}
              {reviewDecision === 'confirmed' && <Badge variant="success">Confirmed</Badge>}
              {reviewDecision === 'rejected' && <Badge variant="destructive">Rejected</Badge>}
              {!reviewDecision && <Badge variant="warning">Pending review</Badge>}
            </CardTitle>
            <CardDescription>
              Confirm or reject <span className="font-medium text-foreground">{fromAccount.companyName}</span> for ICP{' '}
              <code className="font-mono">{fromAccount.icpId}</code>. Updates My Accounts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {reviewError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <IconAlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>{reviewError}</div>
              </div>
            )}

            {!reviewDecision ? (
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  onClick={handleConfirmAccount}
                  disabled={reviewSubmitting}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {reviewSubmitting ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconCircleCheck className="h-4 w-4" />}
                  Confirm
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setRejectOpen((v) => !v)}
                  disabled={reviewSubmitting}
                  className={cn(rejectOpen && 'bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300')}
                >
                  <IconCircleX className="h-4 w-4" />
                  Reject
                  {rejectOpen ? <IconChevronUp className="h-3 w-3 ml-1" /> : <IconChevronDown className="h-3 w-3 ml-1" />}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm text-muted-foreground">
                  {reviewDecision === 'confirmed' ? 'You confirmed this account.' : 'You rejected this account.'}
                </span>
                <Button variant="outline" size="sm" onClick={handleUndoReview} disabled={reviewSubmitting}>
                  {reviewSubmitting ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconRotateClockwise className="h-3.5 w-3.5" />}
                  Undo · back to Pending
                </Button>
                <a href="/accounts" className="text-sm text-sky-600 dark:text-sky-400 hover:underline">
                  ← back to My Accounts
                </a>
              </div>
            )}

            {/* Rejected detail - show the chosen reason + note inline. */}
            {reviewDecision === 'rejected' && reviewReason && (
              <div className="text-xs rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2">
                <div className="font-semibold text-red-700 dark:text-red-300">
                  {REJECT_REASONS.find((r) => r.value === reviewReason)?.label || reviewReason}
                </div>
                {reviewNote && <div className="text-muted-foreground mt-0.5">{reviewNote}</div>}
              </div>
            )}

            {/* Inline reject form - reason picklist + optional note. */}
            {rejectOpen && !reviewDecision && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2.5 space-y-2">
                <div className="text-[11px] uppercase tracking-wider text-red-700 dark:text-red-300 font-semibold flex items-center gap-1.5">
                  <IconCircleX className="h-3 w-3" />
                  Why is this not a fit?
                </div>
                <RejectForm
                  submitting={reviewSubmitting}
                  onCancel={() => setRejectOpen(false)}
                  onSubmit={(reason, note) => handleRejectAccount(reason, note)}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Not-qualified override popup ──────────────────────────────────
          Modeled on the VMS override flow: when the classifier rejects a
          company for the chosen ICP, the rep can Skip, Try another ICP, or
          Override to qualified (persists is_match=true for this ICP). */}
      {overridePrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={overriding ? undefined : handleSkip}
        >
          <div
            className="w-full max-w-md rounded-lg border bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-2">
              <IconAlertTriangle className="h-5 w-5 text-amber-500" />
              <h2 className="text-lg font-semibold">Not qualified for this ICP</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              <span className="font-medium text-foreground">{activeIcpName || 'This ICP'}</span> classified this company as{' '}
              <span className="font-semibold">not a fit</span>.
            </p>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm mb-4">{overridePrompt.reason}</div>
            <p className="text-xs text-muted-foreground mb-4">
              Skip this company, try a different ICP, or override the verdict to mark it qualified for this ICP and continue
              to decision-makers.
            </p>
            <div className="flex flex-col gap-2">
              <Button onClick={handleOverride} disabled={overriding}>
                {overriding ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconCheck className="h-4 w-4" />}
                Override → mark as qualified
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={handleTryAnotherIcp} disabled={overriding}>
                  Try another ICP
                </Button>
                <Button variant="ghost" className="flex-1" onClick={handleSkip} disabled={overriding}>
                  Skip
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Vertical-agnostic verdict card. The ICP-aware classifier returns a binary
// { is_match, reason } plus whatever place facts we have (title/phone/etc.)
// and an optional markdown report - so this renders a Qualified / Not
// qualified badge, the reason, key facts when present, and the report.
function ClassificationCard({
  classification,
  icpName,
  fromCache,
  fromStored,
  onReclassify,
  onReopenOverride,
}: {
  classification: Classification
  icpName?: string
  fromCache?: boolean
  fromStored?: boolean
  onReclassify?: () => void
  onReopenOverride?: () => void
}) {
  const matched = classification.is_match === true
  const overridden = classification.overridden === true
  const name = classification.name || classification.title || classification.domain || 'Unknown company'

  const facts: Array<{ label: string; value: string }> = []
  if (classification.domain) facts.push({ label: 'Domain', value: classification.domain })
  if (classification.phone) facts.push({ label: 'Phone', value: classification.phone })
  if (classification.address) facts.push({ label: 'Address', value: classification.address })
  if (typeof classification.rating === 'number') facts.push({ label: 'Rating', value: String(classification.rating) })

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-bold">{name}</h3>
            {matched ? (
              <Badge variant="success">
                <IconCheck className="h-3 w-3" /> Qualified
              </Badge>
            ) : (
              <Badge variant="destructive">Not qualified</Badge>
            )}
            {overridden && <Badge variant="warning">Manually overridden</Badge>}
            {fromStored
              ? <Badge variant="secondary">Saved result</Badge>
              : fromCache && <Badge variant="secondary">From cache</Badge>}
            {icpName && <Badge variant="outline">ICP: {icpName}</Badge>}
          </div>
          {classification.reason && (
            <p className="text-sm text-muted-foreground mt-1">{classification.reason}</p>
          )}
        </div>
      </div>

      {facts.length > 0 && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {facts.map((f) => (
            <Field key={f.label} label={f.label} value={f.value} />
          ))}
        </div>
      )}

      {/* Actions: re-open the override popup for a rejected company (handy
          if dismissed with Skip), and re-classify a saved result to pick up
          edits to the ICP prompt (forces a fresh GPT run on the cached
          scrape - no re-scrape). */}
      {((!matched && onReopenOverride) || onReclassify) && (
        <div className="flex flex-wrap gap-2">
          {!matched && onReopenOverride && (
            <Button size="sm" variant="outline" onClick={onReopenOverride}>
              <IconAlertTriangle className="h-3 w-3" /> Review / override verdict
            </Button>
          )}
          {onReclassify && (
            <Button size="sm" variant="ghost" onClick={onReclassify} title="Re-run the classifier on the cached scrape (no re-scrape)">
              <IconRefresh className="h-3 w-3" /> Re-classify
            </Button>
          )}
        </div>
      )}

      {classification.report && (
        <>
          <Separator />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Report</div>
            <div className="rounded-lg border border-white/30 dark:border-white/10 bg-white/40 dark:bg-white/[0.03] p-3 max-h-80 overflow-y-auto">
              <Markdown source={classification.report} />
            </div>
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

// Contacts scraped straight off the company website (emails / phones /
// LinkedIn). Shown under the classification as a free fallback to Apollo -
// for a tiny independent these are often the only reachable contact. Renders
// nothing when none were found.
function ScrapedContactsBlock({ contacts }: { contacts: ScrapedContacts | null }) {
  if (!contacts) return null
  const { emails = [], phones = [], linkedinPersonUrls = [], linkedinCompanyUrls = [] } = contacts
  const liUrls = [...linkedinCompanyUrls, ...linkedinPersonUrls]
  if (emails.length === 0 && phones.length === 0 && liUrls.length === 0) return null
  return (
    <div className="mt-3 rounded-lg border border-white/30 dark:border-white/10 bg-white/40 dark:bg-white/[0.03] p-3 text-xs space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Found on website</div>
      {emails.length > 0 && (
        <div className="flex items-start gap-2">
          <IconMail className="h-3.5 w-3.5 mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" />
          <div className="flex flex-wrap gap-1.5">
            {emails.map((e) => (
              <a key={e} href={`mailto:${e}`} className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-300 hover:underline break-all">{e}</a>
            ))}
          </div>
        </div>
      )}
      {phones.length > 0 && (
        <div className="flex items-start gap-2">
          <IconPhone className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="flex flex-wrap gap-1.5">
            {phones.map((p) => (
              <a key={p} href={`tel:${p.replace(/\s+/g, '')}`} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:underline">{p}</a>
            ))}
          </div>
        </div>
      )}
      {liUrls.length > 0 && (
        <div className="flex items-start gap-2">
          <IconBrandLinkedin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="flex flex-wrap gap-1.5">
            {liUrls.map((u) => {
              const isCompany = u.includes('/company/')
              const handle = u.replace(/\/+$/, '').split('/').pop() || u
              return (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:underline" title={u}>
                  {isCompany ? 'company: ' : 'in: '}{handle}
                </a>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// Inline reject form for the bottom-of-page decision bar. Reason picklist
// (canned slugs, matching the Accounts page) + optional free-text note.
function RejectForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (reason: string, note: string) => void
  onCancel: () => void
  submitting: boolean
}) {
  const [reason, setReason] = useState<string>(REJECT_REASONS[0].value)
  const [note, setNote] = useState<string>('')
  return (
    <div className="space-y-2">
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={submitting}
        className="w-full text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
      >
        {REJECT_REASONS.map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </select>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        disabled={submitting}
        placeholder="Optional note (e.g. 'looks closed, no listings updated since 2022')"
        className="w-full text-xs border border-border rounded-md bg-background text-foreground px-2 py-1.5 resize-y [color-scheme:light_dark]"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} disabled={submitting} className="flex-1">
          Cancel
        </Button>
        <Button size="sm" onClick={() => onSubmit(reason, note)} disabled={submitting} className="flex-1 bg-red-600 hover:bg-red-700 text-white">
          {submitting ? <IconLoader2 className="h-3 w-3 animate-spin" /> : null}
          Confirm reject
        </Button>
      </div>
    </div>
  )
}

function LeadRow({
  lead,
  isActive,
  onGenerate,
  disabled,
  enrichingPhone,
  onGetPhone,
  phoneEmpty,
  phoneError,
  canGetPhone,
}: {
  lead: Lead
  isActive: boolean
  onGenerate: () => void
  disabled: boolean
  enrichingPhone: boolean
  onGetPhone: () => void
  phoneEmpty: boolean
  phoneError: string | null
  canGetPhone: boolean
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
          {lead.phone && (
            <a
              href={`tel:${lead.phone}`}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <IconPhone className="h-3 w-3" /> {lead.phone}
            </a>
          )}
          {!lead.phone && lead.hasPhone && (
            <span
              className="flex items-center gap-1 italic"
              title="Apollo's search hinted this contact has a phone. Reveal & generate (or Get phone) will fetch it."
            >
              <IconPhone className="h-3 w-3" /> phone available
            </span>
          )}
        </div>
        {/* Small inline note when the phone re-check came back empty so the
            click doesn't look like a no-op. Cleared on next attempt. */}
        {phoneEmpty && !enrichingPhone && (
          <div className="mt-0.5 text-[10px] text-muted-foreground flex items-center gap-1">
            <IconPhone className="h-2.5 w-2.5" /> Apollo had no phone on file for this contact.
          </div>
        )}
        {phoneError && (
          <div className="mt-0.5 text-[10px] text-destructive flex items-center gap-1">
            <IconAlertTriangle className="h-2.5 w-2.5" /> {phoneError}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <Button size="sm" variant={isActive ? 'default' : 'outline'} onClick={onGenerate} disabled={disabled}>
          <IconMail className="h-3 w-3" />
          {buttonLabel}
        </Button>
        {/* Get-phone is only useful when the lead is already enriched but
            came back without a phone - that's the retry case. For brand-new
            leads, the main Reveal & generate already grabs phone for free
            in the same Apollo call, so showing both would invite a wasted
            credit. canGetPhone gates on apolloId + companyId existing. */}
        {canGetPhone && isEnriched && !lead.phone && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onGetPhone}
            disabled={enrichingPhone}
            className="h-6 px-2 text-[10px] gap-1"
            title="Re-check Apollo for a phone number (1 credit)"
          >
            {enrichingPhone
              ? <IconLoader2 className="h-3 w-3 animate-spin" />
              : <IconPhone className="h-3 w-3" />}
            {enrichingPhone ? 'Checking…' : 'Get phone'}
          </Button>
        )}
      </div>
    </div>
  )
}
