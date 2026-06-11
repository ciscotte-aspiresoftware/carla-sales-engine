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
  IconRobot,
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
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  classifyUrl,
  overrideClassification,
  fetchLeads,
  generateEmail,
  enrichLead,
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
import { safeFetchJson } from '@/lib/safe-fetch'
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
  // Pool of qualified companies for the selected ICP. Populated on ICP
  // pick so the rep can search/click instead of pasting a URL. Empty
  // until they touch an ICP - we don't pre-fetch on page mount because
  // most reps arrive via the prefill hash (Sourcing → Sales Agent) or
  // companyId param (My Accounts) and never use the picker.
  const [icpCompanies, setIcpCompanies] = useState<Array<{ id: string; name?: string; domain?: string; url?: string; country?: string }>>([])
  const [icpCompaniesLoading, setIcpCompaniesLoading] = useState(false)
  // Search query for the company picker. When empty + focused, shows the
  // top 8 by name. When typed, filters by name + domain (client-side -
  // even a long-running portfolio company rarely has > 1k rows in one ICP).
  const [companySearch, setCompanySearch] = useState('')
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false)

  // ─── View / outreach-config state ────────────────────────────────────
  // Top-level panel: 'workspace' shows Steps 1-3 (pick ICP, find leads,
  // configure outreach); 'email' replaces the workspace with a full-width
  // email editor + always-visible Sent/Skipped buttons. The Confirm/Reject
  // bar for My-Accounts-originated flows moves into the email panel so the
  // rep can't miss it (the prior layout pushed it below the fold). Switching
  // is internal state, NOT URL routing, so back-arrow preserves all leads/
  // classification state without a re-fetch.
  const [view, setView] = useState<'workspace' | 'email'>('workspace')
  // Step 1 collapse - user-controlled toggle, not auto. When true, the
  // classification card renders as a 1-line summary so Steps 2+3 get more
  // vertical room. Defaults to false (full card) so first-time reps see
  // the verdict + report in full.
  const [step1Collapsed, setStep1Collapsed] = useState(false)
  // Drives the pulse-ring on the Email tab pill - flips true the moment an
  // email lands, clears the moment the rep switches to the Email tab so it
  // stops nagging once they've seen the draft. Same pattern as the valsource
  // agent page (emailReady state).
  const [emailReady, setEmailReady] = useState(false)
  // Step 3 outreach config. Default template id falls back to the ICP's
  // bound template on selection (see effect below).
  const [outreachTemplateId, setOutreachTemplateId] = useState<string>('')
  const [outreachCustomInstruction, setOutreachCustomInstruction] = useState('')
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
  // - each portfolio company (Carla, Thermeon, NedFox) has its own.
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

  // Load the email-template catalog once on mount. Channel filter is
  // explicit so the LinkedIn-message templates (managed on /li-message)
  // don't pollute the email picker - they're shaped differently (no
  // subject line, no signoff format) and would generate broken output
  // if the model tried to use one for an email draft.
  useEffect(() => {
    fetchEmailTemplates({ channel: 'email' })
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
  // rep doesn't have to scroll past Carla ICPs). When no workspace is
  // set ("All Companies"), every ICP shows.
  const visibleIcps = useMemo(() => {
    if (!workspace) return icps
    const w = workspace.toLowerCase()
    return icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === w)
  }, [icps, workspace])

  // Friendly name for whichever ICP the current classification ran under -
  // used in the override popup + classification card.
  const activeIcpName = icps.find((i) => i.id === activeIcpId)?.name || activeIcpId || ''

  // Fetch the pool of qualified companies for the picker whenever the rep
  // picks (or changes) an ICP. ?match=true scopes to companies whose
  // classifier verdict is_match===true for THIS ICP - hides rejected and
  // unclassified rows so the picker only shows actionable accounts.
  // Empty ICP → clear the list so search results don't leak across ICPs.
  useEffect(() => {
    if (!selectedIcpId) { setIcpCompanies([]); return }
    let cancel = false
    setIcpCompaniesLoading(true)
    ;(async () => {
      try {
        const res = await safeFetchJson(
          `${API_BASE}/api/companies?icp=${encodeURIComponent(selectedIcpId)}&match=true`,
        )
        if (cancel) return
        const list = (res as { companies?: Array<{ id: string; name?: string; domain?: string; url?: string; country?: string }> }).companies || []
        setIcpCompanies(list)
      } catch {
        if (!cancel) setIcpCompanies([])
      } finally {
        if (!cancel) setIcpCompaniesLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [selectedIcpId])

  // Client-side filter for the picker dropdown. No cap on the list - the
  // popover is scrollable (max-h-72 below) so the rep can reach every
  // qualified company in the ICP without typing. Prior 12-item cap was a
  // popover-tightness hack but made "where are the other 55?" the FAQ.
  const filteredCompanies = useMemo(() => {
    const q = companySearch.trim().toLowerCase()
    if (!q) return icpCompanies
    return icpCompanies.filter((c) => {
      const hay = `${c.name || ''} ${c.domain || ''} ${c.country || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [icpCompanies, companySearch])

  // Templates available in the picker. Filtered by workspace (so a
  // NedFox rep doesn't see Carla templates by default). If the rep
  // wants to use a template from another portfolio company, they can
  // pick "All workspaces" via the workspace switcher - there's no
  // per-page override here to keep the picker uncluttered.
  const visibleTemplates = useMemo(() => {
    if (!workspace) return templates
    const w = workspace.toLowerCase()
    return templates.filter((t) => (t.portfolioCompany || '').toLowerCase() === w)
  }, [templates, workspace])

  // After the visible-templates list resolves, anchor activeTemplateId so
  // the <select> value always matches a real option. The empty-value
  // placeholder is gone, so without this the browser would render the
  // first option as visually selected but our state would still be '' -
  // submitting the empty string would silently fall back to backend
  // default resolution which is fine but confusing. Also re-anchor when
  // the current selection drops out of the workspace filter (the rep
  // switched workspaces).
  useEffect(() => {
    if (visibleTemplates.length === 0) return
    if (!activeTemplateId || !visibleTemplates.some((t) => t.id === activeTemplateId)) {
      setActiveTemplateId(visibleTemplates[0].id)
    }
  }, [visibleTemplates, activeTemplateId])

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
  // Mid-flight enrichment for a lead we're about to generate an email for.
  // Stored as the apolloId of the in-flight lead so the lead row can show
  // a "Enriching…" badge while the email + LinkedIn URL aren't visible yet.
  // Cleared as soon as the enriched lead is folded back into the leads list,
  // BEFORE the GPT email-gen call - so the rep sees the contact details
  // appear first, then the email starts streaming below.
  const [preEnrichingApolloId, setPreEnrichingApolloId] = useState<string | null>(null)
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

  // Auto-fetch decision-makers as soon as classification lands qualified.
  // Apollo search-only mode is FREE (no enrichment credits burned - only
  // names + obfuscated last names + titles), so there's no reason to
  // make the rep click. The per-lead "Reveal" button is what spends an
  // Apollo credit; lead discovery itself is just an HTTP request.
  // Skips when:
  //   - classification didn't qualify
  //   - leads already fetched (don't retrigger on every render)
  //   - we're already in flight (handleFetchLeads guards this too but
  //     doubling up keeps the effect deterministic)
  // The fromAccount path used to trigger this elsewhere; consolidating
  // here so both flows behave the same.
  useEffect(() => {
    if (!classification || classification.is_match !== true) return
    if (leads !== null) return
    if (leadsLoading) return
    handleFetchLeads()
    // handleFetchLeads is stable enough for this dep array; using a
    // ref would just hide the same warning. Keep deps lean so the effect
    // doesn't accidentally retrigger from unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classification, leads, leadsLoading])

  // Reveal-only enrichment. Splits the prior "Reveal & generate" coupling
  // - the rep clicks Reveal first, sees the unmasked name + verified
  // email + LinkedIn, THEN decides whether to spend GPT credits by
  // clicking Generate. Same Apollo endpoint as the pre-enrich step in
  // handleGenerateEmail; flagging via preEnrichingApolloId so the row
  // shows the spinner.
  async function handleRevealLead(lead: Lead) {
    if (!lead.apolloId || !companyId || preEnrichingApolloId === lead.apolloId) return
    if (lead.enriched) return // already revealed - nothing to do
    setPreEnrichingApolloId(lead.apolloId)
    try {
      const eRes = await enrichLead(companyId, lead.apolloId)
      const updated = eRes.lead
      if (leads) {
        setLeads(leads.map((l) => (l.apolloId === lead.apolloId ? updated : l)))
      }
      // Promote to active lead so Step 3's Generate button targets this
      // person automatically - rep doesn't have to click Generate on the
      // row, they can just hit the big Step 3 button next.
      setActiveLead(updated)
    } catch (err: any) {
      setLeadsWarnings([...leadsWarnings, `Reveal failed: ${err.message || String(err)}`])
    } finally {
      setPreEnrichingApolloId(null)
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
    setEmailError(null)
    setCopied(false)

    // Phase 1: pre-enrich if needed. We do the Apollo enrichment BEFORE
    // kicking off email generation so the lead row visibly populates the
    // verified email + LinkedIn URL first, then the email starts drafting
    // below it. Prior behaviour did both server-side inside /api/email,
    // which meant the rep saw "enrich to reveal email" right up until the
    // GPT response landed - confusing because the email had nothing to
    // attach to visually.
    //
    // Skipped when:
    //   - already enriched (don't burn another Apollo credit)
    //   - no apolloId (legacy paste flows without Apollo data)
    //   - no companyId (paste-classify flow can't persist back)
    // In any of those cases the email-gen route's server-side fallback
    // still tries to enrich if it can, so we don't lose data.
    let workingLead = lead
    if (!lead.enriched && lead.apolloId && companyId) {
      setPreEnrichingApolloId(lead.apolloId)
      try {
        const eRes = await enrichLead(companyId, lead.apolloId)
        workingLead = eRes.lead
        // Splice the enriched copy back into both `leads` (so the row
        // updates) and `activeLead` (so the email panel header reflects
        // the new name/email immediately).
        if (leads) {
          setLeads(leads.map(l => (l.apolloId === lead.apolloId ? workingLead : l)))
        }
        setActiveLead(workingLead)
      } catch (err: any) {
        // Don't block email gen on enrich failure - the backend's email
        // route will retry server-side. Surface a non-blocking warning so
        // the rep knows credits / Apollo issues happened.
        setLeadsWarnings([...leadsWarnings, `Enrichment failed: ${err.message || String(err)}`])
      } finally {
        setPreEnrichingApolloId(null)
      }
    }

    // Phase 2: email generation. Pass the (now-enriched) workingLead so
    // the server-side path has no enrichment work left to do - it skips
    // the redundant Apollo call when `enriched: true` is already set.
    setEmailLoading(true)
    try {
      const res = await generateEmail({
        classification,
        lead: workingLead,
        companyId: companyId || undefined,
        // Template takes priority over the legacy senderId field. The
        // backend falls back to the Carla-Fazal template if neither
        // is provided, preserving old behaviour for paste-classify flows.
        templateId: activeTemplateId || undefined,
        icpId: fromAccount?.icpId || activeIcpId || undefined,
        senderId: activeTemplateId ? undefined : 'fazal',
        // Step 3's "Custom prompt" textarea - free-form steering, optional.
        // Empty string => not sent. Backend appends it to the user message
        // so GPT respects the rep's specific guidance for THIS draft.
        customInstruction: outreachCustomInstruction.trim() || undefined,
      })
      setEmail(res.email)
      // Switch to the email tab as soon as the draft lands. The Email tab
      // pill pulses (ring + dot) until the rep clicks it - same recency cue
      // the valsource agent uses so a fresh draft is impossible to miss.
      setEmailReady(true)
      setView('email')
      // Server may have done LinkedIn scraping during email gen (separate
      // from Apollo enrich). Swap that copy in too so the People page
      // picks up the LI summary + posts.
      if (res.lead && leads) {
        const updatedLeads = leads.map(l => (l.apolloId === res.lead.apolloId ? res.lead : l))
        setLeads(updatedLeads)
        setActiveLead(res.lead)
      }
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
      {/* Title and description on the SAME line (description aligned to
          baseline so it reads as a continuation). flex-wrap drops the
          description below on narrow viewports so it doesn't squish. */}
      <div className="flex items-baseline flex-wrap gap-x-4 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight shrink-0">Sales Agent</h1>
        <p className="text-sm text-muted-foreground min-w-0">
          {fromAccount
            ? <>Drafting outreach for <span className="font-semibold text-foreground">{fromAccount.companyName}</span> - classification pre-loaded from My Accounts, finding decision-makers now.</>
            : <>Pick an ICP, paste a company website URL - we'll classify the business against that ICP, find decision-makers, and draft an outreach email.</>}
        </p>
      </div>

      {/* Sales Agent / Email tab toggle - left-aligned, sits on its own
          row directly under the header. Mirrors the Runs/Templates strip
          on /sequences. Always visible (even pre-classify) so the rep can
          see the Email tab is the next destination. Email is disabled
          until a draft exists and pulses while fresh (cleared on click). */}
      <div className={cn(GLASS_SUBTLE, 'inline-flex items-center rounded-md p-0.5 gap-0.5')}>
        <button
          onClick={() => setView('workspace')}
          className={cn(
            'px-3 py-1.5 rounded text-xs transition-colors flex items-center gap-1.5',
            view === 'workspace'
              ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
              : 'text-muted-foreground hover:text-foreground',
          )}
          title={view === 'email' ? 'Back to the workspace - classification + leads stay loaded' : undefined}
        >
          <IconRobot className="h-3.5 w-3.5" /> Sales Agent
        </button>
        <button
          onClick={() => {
            if (!email) return
            setView('email')
            setEmailReady(false)
          }}
          disabled={!email}
          className={cn(
            'px-3 py-1.5 rounded text-xs transition-colors flex items-center gap-1.5 relative',
            view === 'email'
              ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
              : 'text-muted-foreground hover:text-foreground',
            !email && 'opacity-50 cursor-not-allowed hover:text-muted-foreground',
            emailReady && 'ring-2 ring-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 animate-pulse',
          )}
          title={!email ? 'Generate an email first to enable this tab' : undefined}
        >
          <IconMail className="h-3.5 w-3.5" /> Email
          {emailReady && <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" />}
        </button>
      </div>

      {/* The grid template flexes when Step 1 is collapsed - Step 1 shrinks
          to a narrow rail (280px) and the right column (Steps 2 + 3 / the
          email panel) gets the rest of the viewport. Defaults to the
          1fr:1.5fr split when Step 1 is expanded. When view='email', the
          grid collapses to a single column so Step 3 (which has the email)
          takes the entire width. */}
      <div className={cn(
        'grid grid-cols-1 gap-6',
        // Workspace view pins to viewport so Steps 2+3 don't waste vertical
        // space. Email view lets the grid content-size - the Body textarea
        // there uses a viewport-relative calc for its own height, so no
        // ancestor flex anchor is needed and CardContent's overflow-y-auto
        // won't introduce a second scrollbar.
        view === 'workspace' && 'lg:h-[calc(100vh-180px)]',
        view === 'email'
          ? 'lg:grid-cols-1'
          : step1Collapsed
            ? 'lg:grid-cols-[280px_1fr]'
            : 'lg:grid-cols-[1fr_1.5fr]',
      )}>

      {/* ─── Step 1: URL → classify (or "From My Accounts" if skipped) ── */}
      {/* Hidden when view='email' - the rep is reviewing the draft, not
          re-analysing. The Sales Agent tab toggle restores it.
          Note: must use a render conditional (not a `hidden` class) because
          Tailwind's `lg:flex` media-query rule wins over the unprefixed
          `hidden` utility at desktop breakpoints, leaving the card visible
          even when view==='email'. */}
      {view !== 'email' && (
      <Card className={cn(GLASS, 'bb-card-in', 'lg:h-full lg:flex lg:flex-col lg:min-h-0')}>
        <CardHeader>
          {/* Collapse / expand toggle - top-right of the card header.
              Lets the rep narrow Step 1 to a 1-line summary so Steps
              2 + 3 (or the email panel) get more vertical + horizontal
              room. User-controlled; doesn't auto-collapse on classify. */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
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
            </div>
            <button
              type="button"
              onClick={() => setStep1Collapsed((v) => !v)}
              className="shrink-0 text-muted-foreground hover:text-foreground p-1 -m-1 rounded-md hover:bg-foreground/[0.05]"
              title={step1Collapsed ? 'Expand Step 1' : 'Collapse Step 1 to give Steps 2/3 more room'}
            >
              {step1Collapsed
                ? <IconChevronDown className="h-3.5 w-3.5" />
                : <IconChevronUp className="h-3.5 w-3.5" />}
            </button>
          </div>
          {/* Collapsed-state summary - only shown when collapsed AND we have
              a classification to summarise. Tells the rep at a glance who
              the company is and the verdict without expanding the card. */}
          {step1Collapsed && classification && (
            <div className="mt-2 text-[11px] text-muted-foreground truncate">
              <span className={cn(
                'font-medium',
                classification.is_match === true ? 'text-emerald-600 dark:text-emerald-400' :
                classification.is_match === false ? 'text-red-600 dark:text-red-400' :
                'text-foreground',
              )}>
                {classification.is_match === true ? '✓' : classification.is_match === false ? '✗' : '·'}{' '}
                {classification.name || classification.title || classification.domain || 'Company'}
              </span>
              {activeIcpName && <span> · {activeIcpName}</span>}
            </div>
          )}
        </CardHeader>
        {/* Collapse hides everything below the header. The Card itself
            still renders so the layout (grid template change) animates
            smoothly. Re-expand from the chevron in the header. */}
        {!step1Collapsed && (
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

              {/* Existing-company picker. Shown once an ICP is selected so
                  the rep can either (a) type to find a previously classified
                  company already in our DB, or (b) skip this row entirely
                  and paste a URL below. Reuses /api/companies?icp=X&match=true
                  which the Sequences picker also hits - server-side filter
                  ensures we only surface qualified accounts. */}
              {selectedIcpId && (
                <div className="relative">
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">Pick</label>
                    <Input
                      placeholder={
                        icpCompaniesLoading
                          ? 'Loading existing accounts…'
                          : icpCompanies.length === 0
                            ? 'No qualified companies in this ICP yet. Paste a URL below.'
                            : `Search ${icpCompanies.length} existing compan${icpCompanies.length === 1 ? 'y' : 'ies'} in this ICP, or paste a URL below`
                      }
                      value={companySearch}
                      onChange={(e) => { setCompanySearch(e.target.value); setCompanyPickerOpen(true) }}
                      onFocus={() => setCompanyPickerOpen(true)}
                      onBlur={() => setTimeout(() => setCompanyPickerOpen(false), 150)}
                      disabled={classifyLoading || icpCompanies.length === 0}
                      className="text-xs"
                    />
                  </div>
                  {companyPickerOpen && filteredCompanies.length > 0 && (
                    <div className="absolute z-10 left-0 right-0 mt-1 rounded-md border border-border bg-background shadow-lg overflow-hidden">
                      <ul className="max-h-80 overflow-y-auto">
                        {filteredCompanies.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              // onMouseDown (not onClick) so the blur on the
                              // input doesn't fire first and close the popover
                              // before the click registers.
                              onMouseDown={(e) => {
                                e.preventDefault()
                                const target = c.url || (c.domain ? `https://${c.domain}` : '')
                                if (target) {
                                  setUrl(target)
                                  setCompanySearch('')
                                  setCompanyPickerOpen(false)
                                }
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-foreground/[0.05] transition-colors flex items-center gap-2"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-medium truncate">{c.name || c.domain || '(unnamed)'}</div>
                                <div className="text-[10px] text-muted-foreground truncate">
                                  {c.domain && <>{c.domain}</>}
                                  {c.country && <> · {c.country}</>}
                                </div>
                              </div>
                              <span className="text-[10px] text-sky-600 dark:text-sky-400 shrink-0">use →</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      {/* Footer count so the rep knows the full size of the
                          ICP cohort and whether they're seeing all of it or
                          a search-filtered subset. */}
                      <div className="border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
                        {companySearch.trim()
                          ? <>Showing {filteredCompanies.length} of {icpCompanies.length} - keep typing to narrow</>
                          : <>All {icpCompanies.length} qualified · scroll for more</>}
                      </div>
                    </div>
                  )}
                  {companyPickerOpen && filteredCompanies.length === 0 && companySearch.trim() && icpCompanies.length > 0 && (
                    <div className="absolute z-10 left-0 right-0 mt-1 rounded-md border border-border bg-background shadow-lg px-3 py-2 text-[11px] text-muted-foreground italic">
                      No matches in this ICP - paste a URL below to classify a new company.
                    </div>
                  )}
                </div>
              )}

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
        )}{/* /!step1Collapsed */}
      </Card>
      )}{/* /view !== email */}

      {/* ─── Right column: Leads (top) + Email (bottom) ──────────────────
          On mobile `display: contents` makes Step 2 and Step 3 act as
          direct grid children so they stack with the rest. On desktop
          this becomes a vertical flex column inside the right grid cell
          so Leads + Email split the available height - Email gets ~2x
          the height since it's the long-form panel the rep actually
          reads/edits. */}
      <div className="contents lg:flex lg:flex-col lg:gap-6 lg:min-h-0">

      {/* ─── Step 2: leads ─────────────────────────────────────────────── */}
      {/* Hidden via render-conditional (same Tailwind override caveat as
          Step 1) when view='email' - the rep is focused on the draft. */}
      {view !== 'email' && (!showLeadsCard ? (
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
              // Apollo returned no decision-makers - common for tiny ops
              // (single-location, founder-only, no LinkedIn presence). Offer
              // a no-name "general" email straight from here so the rep
              // doesn't have to figure out that the Step 3 Generate button
              // also covers this case. Same handler the Step 3 button uses.
              <div className="space-y-2 rounded-md border border-amber-300/40 bg-amber-50/30 dark:bg-amber-950/20 p-3">
                <div className="text-sm text-muted-foreground">
                  No decision-makers found in Apollo for this domain.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleGenerateEmail({
                    firstName: '',
                    lastName: '',
                    title: '',
                    email: null,
                    emailStatus: null,
                    linkedinUrl: null,
                    hasEmail: false,
                    apolloId: null,
                  } as Lead)}
                  disabled={emailLoading || !classification}
                >
                  {emailLoading ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconMail className="h-3 w-3" />}
                  Generate general email
                </Button>
              </div>
            )}
            {leads && leads.length > 0 && (
              <div className="space-y-2">
                {leads.map((lead, i) => (
                  <LeadRow
                    key={lead.apolloId || i}
                    lead={lead}
                    isActive={activeLead?.apolloId === lead.apolloId}
                    onReveal={() => handleRevealLead(lead)}
                    onSelect={() => setActiveLead(lead)}
                    enrichingPhone={!!lead.apolloId && phoneEnriching.has(lead.apolloId)}
                    onGetPhone={() => handleGetPhone(lead)}
                    phoneEmpty={!!lead.apolloId && !!phoneEmpty[lead.apolloId]}
                    phoneError={lead.apolloId ? phoneError[lead.apolloId] || null : null}
                    canGetPhone={!!lead.apolloId && !!companyId}
                    preEnriching={!!lead.apolloId && preEnrichingApolloId === lead.apolloId}
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
      ))}

      {/* ─── Step 3: outreach config + email ────────────────────────────── */}
      {/* Unified card. Pre-classify it's a dim placeholder. Once classified
          the config (template + custom instruction + Generate / Sequence
          buttons) is ALWAYS visible - the prior code hid these behind
          activeLead so reps who had no leads (or hadn't clicked one yet)
          never saw the template selector exists. The email subject+body
          editor appears below the config once a draft is generated. */}
      {!showLeadsCard ? (
        <Card className={cn(GLASS, 'bb-card-in', 'opacity-60', 'lg:flex lg:flex-col lg:min-h-0', view === 'email' ? 'lg:flex-1' : 'lg:flex-none')} style={{ animationDelay: '160ms' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-muted-foreground">
              <IconMail className="h-5 w-5" /> Step 3 · Outreach
            </CardTitle>
            <CardDescription>
              Analyze a company in Step 1 to enable outreach.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className={cn(GLASS, 'bb-card-in', 'lg:flex lg:flex-col lg:min-h-0', view === 'email' ? 'lg:flex-1' : 'lg:flex-none')} style={{ animationDelay: '160ms' }}>
          <CardHeader>
            {/* In Email view the rep already knows they're looking at the
                outreach draft (the tab label says so). Drop the "Step 3 ·
                Outreach" title to clean up vertical space - keep the
                "From X to Y" description so the recipient is obvious. */}
            {view !== 'email' && (
              <CardTitle className="flex items-center gap-2">
                <IconMail className="h-5 w-5" /> Step 3 · Outreach
              </CardTitle>
            )}
            <CardDescription>
              {activeLead && (activeLead.firstName || activeLead.lastName)
                ? <>From {senderLabel} to <span className="font-medium">{activeLead.firstName} {activeLead.lastName || ''}</span>{activeLead.email && <span className="text-xs text-muted-foreground"> · {activeLead.email}</span>}</>
                : leads && leads.length === 0 && classification
                  ? <>From {senderLabel} to <span className="font-medium">{classification.name || classification.domain}</span> <span className="text-xs text-muted-foreground">· general (no contact identified)</span></>
                  : 'Reveal then Select a lead above, or click Generate for a no-name email.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
            {/* ── Config block: Sales Agent tab only ──────────────────
                In the Email tab we strip everything but the draft + the
                Sent/Skip decision so the rep can focus on review. To
                tweak the prompt and regenerate, the rep clicks back to
                the Sales Agent tab. */}
            {view === 'workspace' && (
              <>

            {/* Template picker - drives sender persona + system prompt.
                Filtered by workspace so a NedFox rep doesn't see Carla
                templates by default. */}
            {visibleTemplates.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0 w-20">Template</label>
                {/* No "Default (X)" placeholder option - it was always the
                    same as picking the seeded fazal-carla template
                    explicitly (the backend's empty-templateId path resolved
                    to it by ICP), so it showed up twice and confused reps
                    into thinking there were "3 templates" when there were
                    really 2 (seeded + their custom). */}
                <select
                  value={activeTemplateId}
                  onChange={(e) => setActiveTemplateId(e.target.value)}
                  className="text-xs border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark] flex-1"
                  disabled={emailLoading}
                >
                  {visibleTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.portfolioCompany} · {t.language}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Custom instruction - free-form steering the rep can write
                BEFORE generating. Appended to the user message in the
                prompt so GPT picks up things like "mention their recent
                expansion" or "keep it under 60 words". Persists across
                regenerations on the same lead. */}
            <div className="flex items-start gap-2">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0 w-20 mt-1.5">Custom prompt</label>
              <textarea
                value={outreachCustomInstruction}
                onChange={(e) => setOutreachCustomInstruction(e.target.value)}
                placeholder="Optional · steer the draft, e.g. 'anchor on their recent location expansion' or 'no jargon'"
                rows={2}
                className="flex-1 text-xs border border-border rounded-md bg-background text-foreground px-2 py-1.5 [color-scheme:light_dark] resize-y"
                disabled={emailLoading}
              />
            </div>

            {/* Action button - lives only on the Sales Agent tab. The
                rep edits config here, hits Generate, and the page auto-
                switches to the Email tab for review. */}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {(() => {
                // Generate is enabled in two cases:
                //   - No leads were found (Apollo returned 0) → generate a
                //     no-name email using the classification + scraped contacts.
                //   - The rep has Revealed a lead (activeLead.enriched true)
                //     and that reveal isn't still in flight.
                // If leads exist but none have been revealed yet, the rep
                // needs to click Reveal on a lead row first - we don't
                // silently couple Reveal+Generate any more.
                const noLeadsFlow = !leads || leads.length === 0
                const hasEnrichedActive = !!activeLead && !!activeLead.enriched && preEnrichingApolloId === null
                const canGenerate = !emailLoading && !!classification && (noLeadsFlow || hasEnrichedActive)
                const hint = noLeadsFlow
                  ? 'No Apollo leads on this company - will generate a no-name "Hello," email.'
                  : !activeLead
                    ? 'Click Reveal on a lead above to spend an Apollo credit, then click Generate.'
                    : !activeLead.enriched
                      ? 'Reveal this lead first - we need their verified email + LI before generating.'
                      : preEnrichingApolloId
                        ? 'Reveal in flight - wait for it to land.'
                        : ''
                return (
                  <Button
                    onClick={() => {
                      const target = activeLead || (leads && leads[0])
                      if (target) handleGenerateEmail(target)
                      else if (classification) {
                        // No-leads path - pass an empty lead shape; backend
                        // prompt builder falls back to "Hi there," greeting.
                        handleGenerateEmail({
                          firstName: '',
                          lastName: '',
                          title: '',
                          email: null,
                          emailStatus: null,
                          linkedinUrl: null,
                          hasEmail: false,
                          apolloId: null,
                        } as Lead)
                      }
                    }}
                    disabled={!canGenerate}
                    className="bg-sky-600 hover:bg-sky-700 text-white"
                    title={hint || undefined}
                  >
                    {emailLoading ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconMail className="h-3.5 w-3.5" />}
                    {email ? 'Regenerate email' : noLeadsFlow ? 'Generate general email' : 'Generate email'}
                  </Button>
                )
              })()}
            </div>
              </>
            )}

            {/* ── Email block: appears once the draft lands ──────────── */}
            {/* Hidden in workspace view to keep Step 3 compact (Step 2 gets
                the extra vertical space). When generation completes the
                page auto-switches to email view where Step 3 takes full
                width and renders the Subject/Body editor below. While
                generating we still show a small inline spinner so the rep
                gets feedback without leaving the workspace. */}

            {emailLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground pt-2">
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
            {email && view === 'email' && (
              // Viewport-based textarea height instead of a flex-1 chain.
              // CardContent uses `space-y-3` (margin, not flex), so any
              // flex-1 on nested children would have no flex parent to
              // grow against and the textarea would collapse to its
              // ~2-row HTML default. Calc subtracts the fixed chrome
              // above + below (page title, tab strip, Card padding,
              // Subject row, Body label, Copy button, Confirm/Reject bar
              // if shown). Tuning: bump the 360px term up if anything new
              // gets added above or below the textarea in email view.
              <div className="space-y-3 border-t border-border/40 pt-3">
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
                    // rows sizes the textarea to the email's actual line
                    // count so it ends right where the email ends - that
                    // leaves Copy + the Sent/Skip card visible below
                    // without scrolling. Floor of 8 keeps it from looking
                    // cramped if the model returns a tiny stub. +2 adds a
                    // small buffer below the signoff so the resize handle
                    // and the last line aren't touching. resize-y still
                    // lets the rep drag bigger if they want.
                    rows={Math.max(8, (email.body.match(/\n/g) || []).length + 2)}
                    className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm font-mono leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleCopyEmail} size="sm">
                    <IconCopy className="h-3 w-3" />
                    {copied ? 'Copied!' : 'Copy to clipboard'}
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
          from-Accounts flow - a paste-classify URL has no account to mark.
          Lives inside the Email tab now so the rep makes the Sent/Skip
          call right after reviewing the draft (the natural workflow).
          When still on the Sales Agent tab, the strip is suppressed -
          the rep should review the email before deciding either way. */}
      {fromAccount && view === 'email' && (
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
  onReveal,
  onSelect,
  enrichingPhone,
  onGetPhone,
  phoneEmpty,
  phoneError,
  canGetPhone,
  preEnriching,
}: {
  lead: Lead
  isActive: boolean
  onReveal: () => void
  // Marks this row as the active lead - Step 3's Generate button will
  // target this lead. Doesn't spend any credits; pure UI selection.
  onSelect: () => void
  enrichingPhone: boolean
  onGetPhone: () => void
  phoneEmpty: boolean
  phoneError: string | null
  canGetPhone: boolean
  // True ONLY while the email-gen handler is waiting on Apollo to reveal
  // this row's email + LI. Shows a spinning "Enriching…" badge so the rep
  // sees something is happening on this row.
  preEnriching: boolean
}) {
  const fullName = `${lead.firstName} ${lead.lastName || ''}`.trim() || '(unknown)'
  const isEnriched = !!lead.enriched

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
          {preEnriching && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
              <IconLoader2 className="h-2.5 w-2.5 animate-spin mr-1" /> Enriching…
            </Badge>
          )}
          {isEnriched && !preEnriching && (
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
        {/* Two row actions only:
              - Reveal (when not enriched) → spends an Apollo credit to
                fetch verified email + LinkedIn.
              - Select (when enriched, not active) → marks this lead as
                the target for Step 3's Generate. Pure UI, no credits.
              - Selected pill (when enriched + active) → no button; the
                rep can see this is the lead Step 3 will draft for.
            Generate lives ONLY in Step 3 now so there's exactly one
            "send GPT credits" surface in the flow. */}
        {!isEnriched ? (
          <Button size="sm" variant="outline" onClick={onReveal} disabled={preEnriching} title="Reveal verified email + LinkedIn (1 Apollo credit)">
            {preEnriching ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconCheck className="h-3 w-3" />}
            {preEnriching ? 'Revealing…' : 'Reveal'}
          </Button>
        ) : isActive ? (
          <Badge variant="outline" className="text-[10px] px-2 py-1 border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <IconCheck className="h-3 w-3" /> Selected
          </Badge>
        ) : (
          <Button size="sm" variant="outline" onClick={onSelect} title="Make this the lead Step 3 generates for">
            Select
          </Button>
        )}
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
