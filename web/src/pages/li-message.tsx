// LI Message - scrape any LinkedIn profile + recent posts, preview, and
// generate an outreach email from the LI signals. Two input modes:
//
//   A) Pick from leads:  choose a lead already in the database; uses its
//      cached linkedinUrl, persists the scrape back to companies.json so
//      the Leads page picks it up.
//   B) Paste URL:        free-form LI URL, no persistence; ICP picker is
//      shown so the email gets a template + tone.
//
// Once scraped, the right pane shows three tabs: Profile / Posts / Email.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBrandLinkedin,
  IconUsers,
  IconLoader2,
  IconAlertTriangle,
  IconMail,
  IconCopy,
  IconCheck,
  IconCalendar,
  IconMapPin,
  IconExternalLink,
  IconSparkles,
  IconClipboardCheck,
  IconChevronDown,
} from '@tabler/icons-react'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  fetchAllLeads,
  liMessageScrape,
  liMessageEmail,
  fetchEmailTemplates,
  type LeadRecord,
  type LiSummary,
  type LiPost,
  type GeneratedEmail,
  type EmailTemplateSummary,
} from '@/lib/api'
import { API_BASE } from '@/lib/api-base'
import { useWorkspace } from '@/context/workspace-context'

type InputMode = 'lead' | 'url'
type Tab = 'profile' | 'posts' | 'email'

export default function LiMessagePage() {
  const { workspace } = useWorkspace()

  const [mode, setMode] = useState<InputMode>('lead')

  // Mode A - pick lead
  const [leads, setLeads] = useState<LeadRecord[]>([])
  const [leadsLoading, setLeadsLoading] = useState(false)
  const [leadSearch, setLeadSearch] = useState('')
  const [selectedLeadKey, setSelectedLeadKey] = useState<string | null>(null)

  // Mode B - paste URL
  const [urlInput, setUrlInput] = useState('')

  // ICP picker (mode B, optional for mode A)
  const [icps, setIcps] = useState<Array<{ id: string; name: string; portfolioCompany?: string }>>([])
  const [icpId, setIcpId] = useState<string>('')

  // Templates
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([])
  const [templateId, setTemplateId] = useState<string>('')

  // Scrape result
  const [profile, setProfile] = useState<LiSummary | null>(null)
  const [posts, setPosts] = useState<LiPost[]>([])
  const [cacheHit, setCacheHit] = useState<{ ageDays: number } | null>(null)
  const [scrapedLeadCompany, setScrapedLeadCompany] = useState<string | null>(null)
  const [scrapedLinkedinUrl, setScrapedLinkedinUrl] = useState<string>('')

  // Scrape lifecycle
  const [scraping, setScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState<string | null>(null)

  // Email generation
  const [tab, setTab] = useState<Tab>('profile')
  const [customInstruction, setCustomInstruction] = useState('')
  const [email, setEmail] = useState<GeneratedEmail | null>(null)
  const [emailGenerating, setEmailGenerating] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null)

  // Load leads (with LI URL), templates, ICPs once on mount.
  useEffect(() => {
    setLeadsLoading(true)
    fetchAllLeads({})
      .then(r => {
        // Mode A is "pick someone with an LI URL" - filter to those.
        setLeads(r.leads.filter(l => !!l.linkedinUrl))
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => setLeadsLoading(false))
    fetchEmailTemplates().then(r => setTemplates(r.templates)).catch(() => { /* non-fatal */ })
    fetch(`${API_BASE}/api/icps`)
      .then(r => r.json())
      .then(r => {
        if (r?.success && Array.isArray(r.icps)) {
          setIcps(r.icps.map((i: any) => ({ id: i.id, name: i.name, portfolioCompany: i.portfolioCompany || '' })))
        }
      })
      .catch(() => { /* non-fatal */ })
  }, [])

  // ICP ids that belong to the active workspace (portfolio company). null
  // when no workspace is picked ("All Companies") → no workspace filter.
  // A lead is attributed to a workspace via its companies' ICP
  // classifications (icpIds), so leads on a company with no classifications
  // won't show under a specific workspace - switch to All Companies (or use
  // search) to reach those.
  const workspaceIcpIds = useMemo(() => {
    if (!workspace) return null
    const w = workspace.toLowerCase()
    return new Set(icps.filter(i => (i.portfolioCompany || '').toLowerCase() === w).map(i => i.id))
  }, [icps, workspace])

  // ICP dropdown options, narrowed to the active workspace so a NedFox rep
  // only sees NedFox ICPs.
  const visibleIcps = useMemo(() => {
    if (!workspace) return icps
    const w = workspace.toLowerCase()
    return icps.filter(i => (i.portfolioCompany || '').toLowerCase() === w)
  }, [icps, workspace])

  // People list: scoped to the workspace, then optionally to a single ICP
  // (the ICP picker cycles just the people on companies in that ICP), then
  // narrowed by the search box.
  const visibleLeads = useMemo(() => {
    let out = leads
    if (workspaceIcpIds) {
      out = out.filter(l => (l.icpIds || []).some(id => workspaceIcpIds.has(id)))
    }
    if (icpId) {
      out = out.filter(l => (l.icpIds || []).includes(icpId))
    }
    if (leadSearch.trim()) {
      const q = leadSearch.trim().toLowerCase()
      out = out.filter(l => {
        const hay = [l.firstName, l.lastName, l.title, l.email, l.companyName, l.companyDomain].filter(Boolean).join(' ').toLowerCase()
        return hay.includes(q)
      })
    }
    return out.slice(0, 200)
  }, [leads, workspaceIcpIds, icpId, leadSearch])

  const selectedLead = useMemo(() => {
    if (!selectedLeadKey) return null
    const [companyId, apolloId] = selectedLeadKey.split('|')
    return leads.find(l => l.companyId === companyId && l.apolloId === apolloId) || null
  }, [leads, selectedLeadKey])

  // Clear the ICP filter if a workspace switch puts it out of scope, so the
  // people list doesn't silently filter on an ICP the rep can no longer see.
  useEffect(() => {
    if (icpId && !visibleIcps.some(i => i.id === icpId)) setIcpId('')
  }, [visibleIcps, icpId])

  // Auto-pick a template when the user picks an ICP. Mirrors the backend's
  // two-pass channel-first lookup in suggestTemplate: prefer an LI template
  // bound to this ICP, fall back to an email template if there's no LI
  // counterpart yet. (The backend does the same resolution at generate time,
  // but doing it here too gives the user a visible default in the dropdown
  // so they can see + override before hitting Generate.)
  useEffect(() => {
    if (!icpId || templateId) return
    const liMatch = templates.find(t =>
      (t.channel || 'email') === 'linkedin' && t.defaultForIcps?.includes(icpId)
    )
    const fallback = templates.find(t => t.defaultForIcps?.includes(icpId))
    const match = liMatch || fallback
    if (match) setTemplateId(match.id)
  }, [icpId, templates, templateId])

  // When the user picks a lead, default the ICP to one of the lead's ICPs.
  useEffect(() => {
    if (mode !== 'lead' || !selectedLead) return
    if (icpId) return
    const firstIcp = selectedLead.icpIds?.[0]
    if (firstIcp) setIcpId(firstIcp)
  }, [mode, selectedLead, icpId])

  // Single-button flow - scrape + generate email in one shot, like
  // valsource's LI Scraper /scrape route. Re-scrape is implicit: hitting
  // Generate again with the same inputs re-runs both stages (the backend
  // uses its 30-day cache so the LI scrape is free if recent).
  async function handleGenerate() {
    // Stage 1: scrape
    setScraping(true)
    setScrapeError(null)
    setEmail(null)
    setEmailError(null)
    setCacheHit(null)
    let scrapeRes: Awaited<ReturnType<typeof liMessageScrape>> | null = null
    try {
      if (mode === 'lead') {
        if (!selectedLead) throw new Error('Pick a lead first')
        if (!selectedLead.apolloId) throw new Error('Selected lead has no Apollo ID')
        scrapeRes = await liMessageScrape({
          companyId: selectedLead.companyId,
          apolloId: selectedLead.apolloId,
        })
        setScrapedLinkedinUrl(selectedLead.linkedinUrl || '')
      } else {
        if (!urlInput.trim()) throw new Error('Paste a LinkedIn URL first')
        scrapeRes = await liMessageScrape({ linkedinUrl: urlInput.trim() })
        setScrapedLinkedinUrl(urlInput.trim())
      }
      setProfile(scrapeRes.profileSummary)
      setPosts(scrapeRes.posts || [])
      setScrapedLeadCompany(scrapeRes.companyName || selectedLead?.companyName || null)
      if (scrapeRes.cached && typeof scrapeRes.cacheAgeDays === 'number') setCacheHit({ ageDays: scrapeRes.cacheAgeDays })
    } catch (err: any) {
      setScrapeError(err.message || 'Scrape failed')
      setScraping(false)
      return
    }
    setScraping(false)

    // Stage 2: generate email from the freshly-scraped data
    setEmailGenerating(true)
    try {
      const args: Parameters<typeof liMessageEmail>[0] = {
        profileSummary: scrapeRes!.profileSummary,
        posts: scrapeRes!.posts || [],
        linkedinUrl: (mode === 'lead' ? selectedLead?.linkedinUrl : urlInput.trim()) || undefined,
        icpId: icpId || undefined,
        templateId: templateId || undefined,
        customInstruction: customInstruction.trim() || undefined,
      }
      if (mode === 'lead' && selectedLead) {
        args.companyId = selectedLead.companyId
        args.apolloId = selectedLead.apolloId || undefined
      }
      const res = await liMessageEmail(args)
      setEmail(res.email)
      setTab('email') // Land on the Email tab - that's what they asked for.
    } catch (err: any) {
      setEmailError(err.message || 'Email generation failed')
      setTab('profile') // Fall back to the profile so they at least see the scrape
    } finally {
      setEmailGenerating(false)
    }
  }

  // Re-generate the email only (no re-scrape) - used by the Email tab's
  // Regenerate button after the operator tweaks the custom instruction.
  async function handleRegenerateEmail() {
    if (!profile && posts.length === 0) {
      setEmailError('Generate first')
      return
    }
    setEmailGenerating(true)
    setEmailError(null)
    try {
      const args: Parameters<typeof liMessageEmail>[0] = {
        profileSummary: profile,
        posts,
        linkedinUrl: scrapedLinkedinUrl || undefined,
        icpId: icpId || undefined,
        templateId: templateId || undefined,
        customInstruction: customInstruction.trim() || undefined,
      }
      if (mode === 'lead' && selectedLead) {
        args.companyId = selectedLead.companyId
        args.apolloId = selectedLead.apolloId || undefined
      }
      const res = await liMessageEmail(args)
      setEmail(res.email)
    } catch (err: any) {
      setEmailError(err.message || 'Email generation failed')
    } finally {
      setEmailGenerating(false)
    }
  }

  function copy(text: string, which: 'subject' | 'body') {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which)
      setTimeout(() => setCopied(null), 1200)
    }).catch(() => { /* clipboard blocked - silently fail */ })
  }

  const hasScraped = !!profile || posts.length > 0
  // Workspace-filter, then sort: LinkedIn templates first (this is the LI
  // message page, after all - the channel-appropriate options should be at
  // the top of the dropdown), then email templates. Within each group,
  // preserve the backend's order (which is creation-time). Email templates
  // stay visible so the user can fall back to them if the ICP has no LI
  // counterpart - matches the backend's cross-channel fallback in
  // suggestTemplate.
  const visibleTemplates = useMemo(() => {
    const w = workspace?.toLowerCase()
    const scoped = w
      ? templates.filter(t => (t.portfolioCompany || '').toLowerCase() === w)
      : templates
    return [...scoped].sort((a, b) => {
      const ac = (a.channel || 'email') === 'linkedin' ? 0 : 1
      const bc = (b.channel || 'email') === 'linkedin' ? 0 : 1
      return ac - bc
    })
  }, [templates, workspace])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)] gap-4">
      {/* ─── Left pane: input + controls ─────────────────────────────── */}
      <Card className={GLASS}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <IconBrandLinkedin className="h-5 w-5 text-sky-500" /> LI Message
          </CardTitle>
          <CardDescription>
            Scrape a LinkedIn profile + recent posts, then generate an outreach email seeded from those signals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-muted/40">
            <ModeButton active={mode === 'lead'} onClick={() => setMode('lead')} icon={<IconUsers className="h-3.5 w-3.5" />}>
              Pick lead
            </ModeButton>
            <ModeButton active={mode === 'url'} onClick={() => setMode('url')} icon={<IconBrandLinkedin className="h-3.5 w-3.5" />}>
              Paste URL
            </ModeButton>
          </div>

          {mode === 'lead' ? (
            <div className="space-y-2">
              <Input
                placeholder={leadsLoading ? 'Loading leads…' : 'Search by name, title, company…'}
                value={leadSearch}
                onChange={e => setLeadSearch(e.target.value)}
                disabled={leadsLoading}
                className="text-xs"
              />
              <div className="text-[10px] text-muted-foreground">
                {leadsLoading
                  ? 'Loading…'
                  : `${visibleLeads.length} of ${leads.length} leads with LinkedIn${visibleLeads.length === 200 && leads.length > 200 ? ' (showing top 200 - narrow with search)' : ''}`}
              </div>
              {/* Custom listbox (not a native <select>) so the company name
                  can be styled - native <option> renders plain text only.
                  Each row: Name · Company (blue) · Title. Company falls back
                  to the domain so we never show a bare "(no company)" when a
                  domain is on file. */}
              <div
                role="listbox"
                className="max-h-[22rem] overflow-y-auto rounded-md border border-input bg-background/60 backdrop-blur divide-y divide-border/40"
              >
                {visibleLeads.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {leadsLoading ? 'Loading…' : 'No leads with a LinkedIn URL match.'}
                  </div>
                ) : (
                  visibleLeads.map(l => {
                    const key = `${l.companyId}|${l.apolloId || ''}`
                    const name = `${l.firstName || ''} ${l.lastName || ''}`.trim() || '(unnamed)'
                    const company = l.companyName || l.companyDomain || null
                    const active = selectedLeadKey === key
                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => setSelectedLeadKey(key)}
                        className={cn(
                          'w-full text-left px-2 py-1.5 text-xs flex items-center gap-x-1.5 gap-y-0.5 flex-wrap hover:bg-muted/50 transition-colors',
                          active && 'bg-sky-500/15',
                        )}
                      >
                        <span className="font-medium text-foreground">{name}</span>
                        {company && (
                          <span className="font-semibold text-sky-700 dark:text-sky-300">{company}</span>
                        )}
                        {l.title && <span className="text-muted-foreground">· {l.title}</span>}
                      </button>
                    )
                  })
                )}
              </div>
              {selectedLead && (
                <div className="text-[11px] text-muted-foreground p-2 rounded-md bg-muted/30 space-y-1">
                  <div className="flex items-center gap-1">
                    <IconBrandLinkedin className="h-3 w-3" />
                    <a href={selectedLead.linkedinUrl || '#'} target="_blank" rel="noreferrer" className="hover:underline break-all">
                      {selectedLead.linkedinUrl}
                    </a>
                  </div>
                  {selectedLead.liScrapedAt && (
                    <div>
                      Cached LinkedIn scrape ·{' '}
                      {Math.round((Date.now() - selectedLead.liScrapedAt) / (24 * 60 * 60 * 1000))}d old
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                placeholder="https://www.linkedin.com/in/username"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                className="text-xs"
              />
              <div className="text-[11px] text-muted-foreground">
                Paste-URL mode doesn't persist to the leads database - pick the ICP below so the email gets a tone.
              </div>
            </div>
          )}

          {/* ICP picker - required for paste-URL mode (sets tone), and in
              pick-lead mode it also filters the people list to that ICP. */}
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground">
              ICP{mode === 'url' ? ' (recommended)' : ' (filters people)'}
            </label>
            <select
              value={icpId}
              onChange={e => setIcpId(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded-md border border-input bg-background/60 backdrop-blur"
            >
              <option value="">{mode === 'lead' ? (workspace ? `All ${workspace} ICPs` : 'All ICPs') : 'Any'}</option>
              {visibleIcps.map(i => (
                <option key={i.id} value={i.id}>{i.name}{!workspace && i.portfolioCompany ? ` · ${i.portfolioCompany}` : ''}</option>
              ))}
            </select>
          </div>

          {/* Template picker. LI templates appear first (channel-appropriate
              for this page), email templates fall through as a fallback -
              same priority as the backend's suggestTemplate.
              Custom combobox (not <select>) because browser <option> elements
              render plain text only; we need the LinkedIn / email icon on
              each row. Pattern mirrors the lead picker above this. */}
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground">Template</label>
            <TemplatePicker
              templates={visibleTemplates}
              value={templateId}
              onChange={setTemplateId}
            />
          </div>

          {/* Custom instruction - moved up here from the Email tab so the
              operator sets every input on the left, then hits one button. */}
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground">Custom instruction (optional)</label>
            <textarea
              value={customInstruction}
              onChange={e => setCustomInstruction(e.target.value)}
              placeholder='e.g. "Lead with the Lisbon airport hiring post" or "Keep it under 80 words"'
              rows={2}
              className="w-full px-2 py-1.5 text-xs rounded-md border border-input bg-background/60 backdrop-blur resize-none"
            />
          </div>

          {/* Single-shot Generate button - scrape + email gen in one flow */}
          <Button onClick={handleGenerate} disabled={scraping || emailGenerating} className="w-full gap-1.5">
            {scraping
              ? <IconLoader2 className="h-4 w-4 animate-spin" />
              : emailGenerating
                ? <IconLoader2 className="h-4 w-4 animate-spin" />
                : <IconSparkles className="h-4 w-4" />}
            {scraping
              ? 'Scraping LinkedIn…'
              : emailGenerating
                ? 'Generating email…'
                : email
                  ? 'Regenerate'
                  : 'Generate'}
          </Button>

          {scrapeError && (
            <div className="text-xs text-destructive flex items-center gap-1">
              <IconAlertTriangle className="h-3 w-3" /> {scrapeError}
            </div>
          )}
          {cacheHit && (
            <div className="text-[11px] text-muted-foreground">
              Reused cached LinkedIn scrape ({cacheHit.ageDays}d old).
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Right pane: preview + email gen ────────────────────────── */}
      <div className="space-y-3">
        {!hasScraped && !scraping && (
          <Card className={GLASS_SUBTLE}>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {mode === 'lead'
                ? 'Pick a lead and hit Generate - the profile, posts, and the outreach email will all land here.'
                : 'Paste a LinkedIn URL and hit Generate - the profile, posts, and the outreach email will all land here.'}
            </CardContent>
          </Card>
        )}

        {hasScraped && (
          <>
            {/* Tabs */}
            <Card className={GLASS}>
              <div className="flex border-b border-border/40">
                <TabButton active={tab === 'profile'} onClick={() => setTab('profile')}>
                  Profile
                </TabButton>
                <TabButton active={tab === 'posts'} onClick={() => setTab('posts')}>
                  Posts {posts.length > 0 && <span className="ml-1 text-muted-foreground">({posts.length})</span>}
                </TabButton>
                <TabButton active={tab === 'email'} onClick={() => setTab('email')}>
                  Email
                </TabButton>
              </div>

              <CardContent className="pt-4 text-xs">
                {tab === 'profile' && (
                  <ProfileTab profile={profile} url={scrapedLinkedinUrl} companyName={scrapedLeadCompany} />
                )}
                {tab === 'posts' && <PostsTab posts={posts} />}
                {tab === 'email' && (
                  <EmailTab
                    email={email}
                    generating={emailGenerating}
                    error={emailError}
                    onRegenerate={handleRegenerateEmail}
                    onCopy={copy}
                    copied={copied}
                  />
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

// Custom combobox for the template picker. Replaces a native <select> so
// each row can render a real channel icon (LinkedIn brand mark for LI
// templates, mail glyph for email) - browser <option> elements only
// support plain text. Closed state: button shows current selection's icon
// + label. Click opens a panel positioned absolutely below; click outside
// closes. Keyboard escape closes. The "Auto" sentinel option at the top
// maps to empty-string `value` (matches the backend's "resolve at request
// time" behaviour).
function TemplatePicker({
  templates,
  value,
  onChange,
}: {
  templates: EmailTemplateSummary[]
  value: string
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  // Position the floating panel by the trigger's bounding rect, then render
  // it via Portal to document.body. The container Card has overflow-hidden
  // up its tree (the GLASS style + an h-full rail), so a normal
  // absolute-position panel would get clipped right at the card edge - the
  // bug the user is reporting. Portal escapes that. Recomputed on every
  // open + on scroll/resize while open so it tracks layout changes.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)

  const reposition = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.bottom + 4, left: r.left, width: r.width })
  }

  // Compute the initial position synchronously on open so the panel lands
  // in the right spot on its very first paint (no one-frame flicker).
  useLayoutEffect(() => {
    if (!open) return
    reposition()
  }, [open])

  // Track scroll + resize while open so the panel follows the trigger
  // instead of detaching when the user scrolls the page. We listen on
  // window with `capture: true` so scrolls inside nested scroll containers
  // (the card list rail, etc.) also reposition us. Cheap - just reads a
  // bounding rect.
  useEffect(() => {
    if (!open) return
    const handler = () => reposition()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
  }, [open])

  // Click-outside + escape-to-close. Click-outside must check BOTH the
  // trigger and the portaled panel (they're no longer DOM siblings under
  // one root).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = templates.find((t) => t.id === value) || null

  const ChannelIcon = ({ channel, className }: { channel?: string; className?: string }) =>
    (channel || 'email') === 'linkedin'
      ? <IconBrandLinkedin className={cn('h-3.5 w-3.5 text-sky-600 dark:text-sky-400 shrink-0', className)} />
      : <IconMail className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0', className)} />

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-8 px-2 text-xs rounded-md border border-input bg-background/60 backdrop-blur flex items-center gap-1.5 text-left"
      >
        {selected ? (
          <>
            <ChannelIcon channel={selected.channel} />
            <span className="flex-1 truncate font-medium text-foreground">{selected.name}</span>
            <span className="text-muted-foreground truncate">
              {selected.sender.firstName}{selected.sender.lastName ? ` ${selected.sender.lastName}` : ''}
            </span>
          </>
        ) : (
          <>
            <IconSparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="flex-1 truncate text-muted-foreground">
              Auto (LinkedIn preferred, falls back to email)
            </span>
          </>
        )}
        <IconChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
          className="z-50 max-h-[22rem] overflow-y-auto rounded-md border border-input bg-background shadow-lg divide-y divide-border/40"
        >
          {/* Auto option - sentinel for "let the backend resolve from ICP". */}
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => { onChange(''); setOpen(false) }}
            className={cn(
              'w-full text-left px-2 py-1.5 text-xs flex items-center gap-1.5 hover:bg-muted/50 transition-colors',
              !value && 'bg-sky-500/15',
            )}
          >
            <IconSparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="font-medium text-foreground">Auto</span>
            <span className="text-muted-foreground">LinkedIn preferred, falls back to email</span>
          </button>
          {templates.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">No templates available.</div>
          ) : (
            templates.map((t) => {
              const active = value === t.id
              const sender = `${t.sender.firstName}${t.sender.lastName ? ` ${t.sender.lastName}` : ''}`
              return (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => { onChange(t.id); setOpen(false) }}
                  className={cn(
                    'w-full text-left px-2 py-1.5 text-xs flex items-center gap-1.5 hover:bg-muted/50 transition-colors',
                    active && 'bg-sky-500/15',
                  )}
                >
                  <ChannelIcon channel={t.channel} />
                  <span className="font-medium text-foreground truncate">{t.name}</span>
                  <span className="text-muted-foreground truncate">· {sender}</span>
                </button>
              )
            })
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

function ModeButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center gap-1.5 h-8 text-xs rounded-md transition-colors border',
        active
          // Active: sky-blue fill matches LinkedIn branding + the segmented
          // controls on Costs / Coverage so the "this is the selected mode"
          // signal is consistent across the app.
          ? 'bg-sky-500/20 border-sky-500/40 text-sky-700 dark:text-sky-300 font-semibold'
          // Inactive: faint sky bg + persistent border + sky-tinted icon
          // (via [&_svg]:text-sky-500/70) + a slow pulsing glow ring
          // (mode-hint-pulse). All three combined so reps see "this is a
          // button I can switch to" at rest, not just on hover.
          : 'bg-sky-500/[0.04] border-sky-500/20 text-foreground/80 [&_svg]:text-sky-500/70 hover:bg-sky-500/10 hover:border-sky-500/40 hover:text-foreground mode-hint-pulse',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-4 py-2 text-xs font-medium border-b-2 transition-colors',
        active
          ? 'border-sky-500 text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function ProfileTab({ profile, url, companyName }: { profile: LiSummary | null; url: string; companyName: string | null }) {
  if (!profile) return <div className="text-muted-foreground italic">No profile data.</div>
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold">{profile.name || '(unnamed)'}</span>
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <IconExternalLink className="h-3 w-3" /> open
            </a>
          )}
        </div>
        {profile.headline && <div className="text-muted-foreground">{profile.headline}</div>}
        <div className="flex items-center gap-3 text-muted-foreground">
          {profile.location && (
            <span className="inline-flex items-center gap-1"><IconMapPin className="h-3 w-3" /> {profile.location}</span>
          )}
          {companyName && (
            <span className="inline-flex items-center gap-1"><IconClipboardCheck className="h-3 w-3" /> {companyName}</span>
          )}
        </div>
      </div>

      {profile.about && (
        <Section label="About">
          <p className="leading-relaxed">{profile.about}</p>
        </Section>
      )}
      {profile.current && (
        <Section label="Current">
          <div>{profile.current}</div>
        </Section>
      )}
      {profile.experience && (
        <Section label="Experience">
          <pre className="whitespace-pre-wrap font-sans text-[11px]">{profile.experience}</pre>
        </Section>
      )}
      {profile.promotions && !profile.recentPromotion && (
        <Section label="Tenure">
          <div className="text-muted-foreground">{profile.promotions}</div>
        </Section>
      )}
      {profile.recentPromotion && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">
          🎉 Recent promotion: started "{profile.recentPromotion.newRole}" at {profile.recentPromotion.company}
          {profile.recentPromotion.monthsAgo === 0 ? ' this month' : ` ${profile.recentPromotion.monthsAgo}mo ago`}
          {profile.recentPromotion.priorRole && ` (was "${profile.recentPromotion.priorRole}")`}
        </div>
      )}
    </div>
  )
}

function PostsTab({ posts }: { posts: LiPost[] }) {
  if (!posts || posts.length === 0) {
    return <div className="text-muted-foreground italic">No recent posts found for this profile.</div>
  }
  return (
    <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
      {posts.map((p, i) => {
        const meta = [
          p.date ? String(p.date) : 'date unknown',
          (p.likes ?? 0) > 0 ? `${p.likes} likes` : null,
          (p.comments ?? 0) > 0 ? `${p.comments} comments` : null,
        ].filter(Boolean).join(' · ')
        return (
          <div key={i} className="rounded border border-border/40 bg-background/40 p-2">
            <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
              <IconCalendar className="h-2.5 w-2.5" /> {meta}
            </div>
            <div className="text-[11px] whitespace-pre-wrap leading-relaxed">{p.text}</div>
          </div>
        )
      })}
    </div>
  )
}

function EmailTab({
  email, generating, error, onRegenerate, onCopy, copied,
}: {
  email: GeneratedEmail | null
  generating: boolean
  error: string | null
  onRegenerate: () => void
  onCopy: (text: string, which: 'subject' | 'body') => void
  copied: 'subject' | 'body' | null
}) {
  return (
    <div className="space-y-3">
      {/* The primary "Generate" button lives on the left pane now - this is
          only used to re-run the email step after tweaking the custom
          instruction. Hidden until we have a first draft. */}
      {email && (
        <div className="flex justify-end">
          <Button
            onClick={onRegenerate}
            disabled={generating}
            variant="outline"
            size="sm"
            className="gap-1.5 h-7 text-xs"
          >
            {generating
              ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
              : <IconSparkles className="h-3.5 w-3.5" />}
            {generating ? 'Regenerating…' : 'Regenerate'}
          </Button>
        </div>
      )}

      {error && (
        <div className="text-xs text-destructive flex items-center gap-1">
          <IconAlertTriangle className="h-3 w-3" /> {error}
        </div>
      )}

      {email && (
        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Subject</span>
              <button
                onClick={() => onCopy(email.subject, 'subject')}
                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                {copied === 'subject' ? <IconCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                {copied === 'subject' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="text-sm font-medium px-3 py-2 rounded-md bg-muted/40">{email.subject}</div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Body</span>
              <button
                onClick={() => onCopy(email.body, 'body')}
                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                {copied === 'body' ? <IconCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                {copied === 'body' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="text-xs whitespace-pre-wrap leading-relaxed px-3 py-2 rounded-md bg-muted/40">{email.body}</div>
          </div>
        </div>
      )}

      {!email && generating && (
        <div className="text-[11px] text-muted-foreground italic flex items-center gap-1.5">
          <IconLoader2 className="h-3 w-3 animate-spin" /> Generating email…
        </div>
      )}
      {!email && !generating && !error && (
        <div className="text-[11px] text-muted-foreground italic">
          The generated email will appear here. <IconMail className="inline h-3 w-3" />
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">{label}</div>
      <div>{children}</div>
    </div>
  )
}
