// Leads - read-only database of every stored lead across every company.
// Mirrors database.tsx filter chrome (vertical / ICP / portfolio company)
// plus lead-specific filters (has-LinkedIn-cache, has-verified-email,
// free-text search). Each row expands to show the cached LinkedIn profile
// + recent posts so the rep can preview what the email generator will
// see before triggering a send.

import { useEffect, useMemo, useState } from 'react'
import {
  IconUsers,
  IconLoader2,
  IconAlertTriangle,
  IconRefresh,
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconBrandLinkedin,
  IconMail,
  IconMapPin,
  IconBuilding,
  IconCalendar,
  IconSparkles,
  IconPhone,
} from '@tabler/icons-react'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyEmail } from '@/components/ui/copy-email'
import { ToastContainer, addToast } from '@/components/ui/toast'
import { LeadStatusBadges } from '@/components/ui/lead-status-badges'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  fetchAllLeads,
  fetchVerticals,
  fetchPortfolioCompanies,
  enrichLead,
  enrichLeadPhone,
  type LeadRecord,
  type FetchAllLeadsFilters,
} from '@/lib/api'
import { API_BASE } from '@/lib/api-base'
import { useWorkspace } from '@/context/workspace-context'

export default function LeadsPage() {
  const { workspace } = useWorkspace()

  const [leads, setLeads] = useState<LeadRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Tracks which lead rows have an in-flight enrich call so we can disable
  // the button + show a spinner per-row. Key = "companyId:apolloId".
  const [enriching, setEnriching] = useState<Set<string>>(new Set())
  const [enrichingPhone, setEnrichingPhone] = useState<Set<string>>(new Set())
  const [rowError, setRowError] = useState<Record<string, string>>({})
  // After a phone-only enrich, surface a one-shot "no phone on file" note
  // when Apollo returns nothing - otherwise the click looks like a no-op.
  const [phoneEmptyNote, setPhoneEmptyNote] = useState<Record<string, true>>({})

  // Filter state - verticals/portfolio/ICP mirror /database. Has-LI and
  // has-email are tri-state ('' = ignore, 'true' = require, 'false' =
  // exclude). Search is debounced via a separate state so we don't refetch
  // on every keystroke.
  const [verticalFilter, setVerticalFilter] = useState<string>('')
  const [icpFilter, setIcpFilter] = useState<string>('')
  const [portfolioFilter, setPortfolioFilter] = useState<string>(workspace)
  const [hasLiFilter, setHasLiFilter] = useState<'' | 'true' | 'false'>('')
  const [hasEmailFilter, setHasEmailFilter] = useState<'' | 'true' | 'false'>('')
  const [searchInput, setSearchInput] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [sortBy, setSortBy] = useState<'recent' | 'liCache' | 'company'>('recent')

  const [verticals, setVerticals] = useState<string[]>([])
  const [portfolioCompanies, setPortfolioCompanies] = useState<string[]>([])
  const [icps, setIcps] = useState<Array<{ id: string; name: string; vertical: string; portfolioCompany?: string }>>([])

  // Load static dropdown sources once.
  useEffect(() => {
    fetchVerticals().then(r => setVerticals(r.verticals)).catch(() => { /* non-fatal */ })
    fetchPortfolioCompanies().then(r => setPortfolioCompanies(r.portfolioCompanies)).catch(() => { /* non-fatal */ })
    fetch(`${API_BASE}/api/icps`)
      .then(r => r.json())
      .then(r => {
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

  // Sync portfolio filter with workspace switcher (same UX as /database).
  useEffect(() => { setPortfolioFilter(workspace) }, [workspace])

  // Debounce the search input → search term so each keystroke doesn't
  // refire the GET. 300ms is the same delay /database uses.
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Refetch when any filter changes.
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verticalFilter, icpFilter, portfolioFilter, hasLiFilter, hasEmailFilter, searchTerm])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const filters: FetchAllLeadsFilters = {}
      if (verticalFilter) filters.vertical = verticalFilter
      if (icpFilter) filters.icp = icpFilter
      if (portfolioFilter) filters.portfolioCompany = portfolioFilter
      if (hasLiFilter) filters.hasLi = hasLiFilter === 'true'
      if (hasEmailFilter) filters.hasEmail = hasEmailFilter === 'true'
      if (searchTerm) filters.search = searchTerm
      const res = await fetchAllLeads(filters)
      setLeads(res.leads)
    } catch (err: any) {
      setError(err.message || 'Failed to load leads')
    } finally {
      setLoading(false)
    }
  }

  // Narrow ICPs by vertical + portfolio so users can't pick a mismatch.
  const availableIcps = useMemo(() => {
    let out = icps
    if (verticalFilter) {
      const v = verticalFilter.toLowerCase()
      out = out.filter(i => (i.vertical || '').toLowerCase() === v)
    }
    if (portfolioFilter) {
      const p = portfolioFilter.toLowerCase()
      out = out.filter(i => (i.portfolioCompany || '').toLowerCase() === p)
    }
    return out
  }, [icps, verticalFilter, portfolioFilter])

  // Clear ICP filter when scope changes and it's no longer valid.
  useEffect(() => {
    if (!icpFilter) return
    if (!verticalFilter && !portfolioFilter) return
    const stillValid = availableIcps.some(i => i.id === icpFilter)
    if (!stillValid) setIcpFilter('')
  }, [verticalFilter, portfolioFilter, availableIcps, icpFilter])

  // Verticals that exist within the active portfolio scope.
  const visibleVerticals = useMemo(() => {
    if (!portfolioFilter) return verticals
    const p = portfolioFilter.toLowerCase()
    const allowed = new Set(
      icps
        .filter(i => (i.portfolioCompany || '').toLowerCase() === p)
        .map(i => (i.vertical || '').toLowerCase())
        .filter(Boolean),
    )
    return verticals.filter(v => allowed.has(v.toLowerCase()))
  }, [verticals, icps, portfolioFilter])

  function toggleRow(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Single-row Apollo enrich. Splice the updated lead back into state in
  // place so we don't lose scroll position or sort order on success.
  async function handleEnrich(lead: LeadRecord) {
    if (!lead.apolloId) return
    const key = `${lead.companyId}:${lead.apolloId}`
    setEnriching(prev => {
      const next = new Set(prev); next.add(key); return next
    })
    setRowError(prev => { const { [key]: _drop, ...rest } = prev; return rest })
    try {
      const res = await enrichLead(lead.companyId, lead.apolloId)
      setLeads(prev => prev.map(l => {
        if (l.companyId !== lead.companyId || l.apolloId !== lead.apolloId) return l
        // Merge: keep company-context fields the endpoint doesn't return,
        // overlay the freshly-enriched Lead fields.
        return { ...l, ...res.lead }
      }))
    } catch (err: any) {
      setRowError(prev => ({ ...prev, [key]: err.message || 'Enrich failed' }))
    } finally {
      setEnriching(prev => {
        const next = new Set(prev); next.delete(key); return next
      })
    }
  }

  // Phone-only enrich. Same Apollo call as /enrich under the hood, but the
  // backend only persists the phone field - leaves email/LI alone. If Apollo
  // had no phone on file, we surface a small one-shot "Apollo had no phone
  // for this contact" note so the click doesn't look like a no-op.
  async function handleEnrichPhone(lead: LeadRecord) {
    if (!lead.apolloId) return
    const key = `${lead.companyId}:${lead.apolloId}`
    setEnrichingPhone(prev => { const next = new Set(prev); next.add(key); return next })
    setRowError(prev => { const { [key]: _drop, ...rest } = prev; return rest })
    setPhoneEmptyNote(prev => { const { [key]: _drop, ...rest } = prev; return rest })
    try {
      const res = await enrichLeadPhone(lead.companyId, lead.apolloId)

      // Waterfall enrichment is async - Apollo will enrich in background and
      // POST the result to our webhook. Poll for the phone to arrive (~minutes).
      if (res.waterfall_pending) {
        addToast(`📱 Phone reveal in progress for ${lead.firstName} ${lead.lastName || ''}`, 'info', 5000)

        // Poll every 5s for up to 5 minutes for the phone to arrive
        const maxAttempts = 60
        let attempts = 0
        const pollInterval = setInterval(async () => {
          attempts++
          if (attempts > maxAttempts) {
            clearInterval(pollInterval)
            setEnrichingPhone(prev => { const next = new Set(prev); next.delete(key); return next })
            return
          }
          try {
            const updated = await fetch(`${API_BASE}/api/leads?companyId=${lead.companyId}&search=${lead.apolloId}`)
              .then(r => r.json())
              .then(r => (r.leads || []).find((l: any) => l.apolloId === lead.apolloId))
            if (updated?.phone && updated.phone !== lead.phone) {
              clearInterval(pollInterval)
              setLeads(prev => prev.map(l => {
                if (l.companyId !== lead.companyId || l.apolloId !== lead.apolloId) return l
                return { ...l, ...updated }
              }))
              addToast(`✅ Phone number revealed for ${lead.firstName} ${lead.lastName || ''}`, 'success', 4000)
              setEnrichingPhone(prev => { const next = new Set(prev); next.delete(key); return next })
            }
          } catch (e) { /* silently ignore poll errors */ }
        }, 5000)
      }
    } catch (err: any) {
      setRowError(prev => ({ ...prev, [key]: err.message || 'Phone reveal failed' }))
      setEnrichingPhone(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  const stats = useMemo(() => {
    let withLi = 0, withEmail = 0
    for (const l of leads) {
      if (l.liScrapedAt) withLi++
      if (l.email) withEmail++
    }
    return { total: leads.length, withLi, withEmail }
  }, [leads])

  // Effective "added" date for a lead: prefer the per-lead stamp, fall
  // back to the company's createdAt (the earliest possible date the lead
  // could have been attached). The "approx" flag tells the UI to prefix
  // with ~ so the user can see it's a fallback, not a real per-lead date.
  function effectiveAddedAt(l: LeadRecord): { ts: number | null; approx: boolean } {
    if (l.addedAt) return { ts: l.addedAt, approx: false }
    if (l.companyCreatedAt) return { ts: l.companyCreatedAt, approx: true }
    return { ts: null, approx: false }
  }

  const visibleLeads = useMemo(() => {
    const arr = [...leads]
    if (sortBy === 'recent') {
      arr.sort((a, b) => {
        const aTs = effectiveAddedAt(a).ts || 0
        const bTs = effectiveAddedAt(b).ts || 0
        return bTs - aTs
      })
    } else if (sortBy === 'liCache') {
      arr.sort((a, b) => {
        const aLi = a.liScrapedAt ? 1 : 0
        const bLi = b.liScrapedAt ? 1 : 0
        if (aLi !== bLi) return bLi - aLi
        const aEnr = a.enriched ? 1 : 0
        const bEnr = b.enriched ? 1 : 0
        if (aEnr !== bEnr) return bEnr - aEnr
        return (a.companyName || '').localeCompare(b.companyName || '')
      })
    } else {
      arr.sort((a, b) => (a.companyName || '').localeCompare(b.companyName || ''))
    }
    return arr
  }, [leads, sortBy])

  return (
    <div className="space-y-4">
      <Card className={GLASS}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <IconUsers className="h-5 w-5" /> People
              </CardTitle>
              <CardDescription>
                {stats.total} total · {stats.withLi} with LinkedIn cache · {stats.withEmail} with verified email
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
              <IconRefresh className={cn('h-4 w-4', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Filter row 1: portfolio / vertical / ICP - mirrors /database */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Portfolio"
              value={portfolioFilter}
              onChange={setPortfolioFilter}
              options={[{ value: '', label: 'All' }, ...portfolioCompanies.map(p => ({ value: p, label: p }))]}
            />
            <FilterSelect
              label="Vertical"
              value={verticalFilter}
              onChange={setVerticalFilter}
              options={[{ value: '', label: 'All' }, ...visibleVerticals.map(v => ({ value: v, label: v }))]}
            />
            <FilterSelect
              label="ICP"
              value={icpFilter}
              onChange={setIcpFilter}
              options={[{ value: '', label: 'Any' }, ...availableIcps.map(i => ({ value: i.id, label: i.name }))]}
            />
          </div>
          {/* Filter row 2: lead-specific */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="LinkedIn cache"
              value={hasLiFilter}
              onChange={v => setHasLiFilter(v as '' | 'true' | 'false')}
              options={[
                { value: '', label: 'Any' },
                { value: 'true', label: 'Has cached LI' },
                { value: 'false', label: 'No LI cache' },
              ]}
            />
            <FilterSelect
              label="Verified email"
              value={hasEmailFilter}
              onChange={v => setHasEmailFilter(v as '' | 'true' | 'false')}
              options={[
                { value: '', label: 'Any' },
                { value: 'true', label: 'Has email' },
                { value: 'false', label: 'No email' },
              ]}
            />
            <FilterSelect
              label="Sort by"
              value={sortBy}
              onChange={v => setSortBy(v as 'recent' | 'liCache' | 'company')}
              options={[
                { value: 'recent', label: 'Most recent' },
                { value: 'liCache', label: 'LI cached first' },
                { value: 'company', label: 'Company A→Z' },
              ]}
            />
            <input
              type="search"
              placeholder="Search name, title, email, company…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="flex-1 min-w-[220px] h-8 px-3 text-xs rounded-md border border-input bg-background/60 backdrop-blur"
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className={cn(GLASS_SUBTLE, 'border-destructive/40')}>
          <CardContent className="py-3 px-4 flex items-center gap-2 text-sm text-destructive">
            <IconAlertTriangle className="h-4 w-4" /> {error}
          </CardContent>
        </Card>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
          <IconLoader2 className="h-5 w-5 animate-spin" /> Loading people…
        </div>
      )}

      {!loading && !error && leads.length === 0 && (
        <Card className={GLASS_SUBTLE}>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No people match the current filters.
          </CardContent>
        </Card>
      )}

      {!loading && !error && leads.length > 0 && (
        <div className="space-y-2">
          {visibleLeads.map((lead, idx) => {
            const rowKey = `${lead.companyId}:${lead.apolloId || lead.email || idx}`
            const enrichKey = lead.apolloId ? `${lead.companyId}:${lead.apolloId}` : ''
            const isOpen = expanded.has(rowKey)
            const { ts, approx } = effectiveAddedAt(lead)
            return (
              <LeadRow
                key={rowKey}
                lead={lead}
                expanded={isOpen}
                onToggle={() => toggleRow(rowKey)}
                addedAt={ts}
                addedAtApprox={approx}
                enriching={enrichKey ? enriching.has(enrichKey) : false}
                onEnrich={() => handleEnrich(lead)}
                enrichError={enrichKey ? rowError[enrichKey] || null : null}
                enrichingPhone={enrichKey ? enrichingPhone.has(enrichKey) : false}
                onEnrichPhone={() => handleEnrichPhone(lead)}
                phoneEmpty={enrichKey ? !!phoneEmptyNote[enrichKey] : false}
              />
            )
          })}
        </div>
      )}
      <ToastContainer />
    </div>
  )
}

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-8 px-2 text-xs rounded-md border border-input bg-background/60 backdrop-blur"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function LeadRow({
  lead, expanded, onToggle, addedAt, addedAtApprox, enriching, onEnrich, enrichError,
  enrichingPhone, onEnrichPhone, phoneEmpty,
}: {
  lead: LeadRecord
  expanded: boolean
  onToggle: () => void
  addedAt: number | null
  addedAtApprox: boolean
  enriching: boolean
  onEnrich: () => void
  enrichError: string | null
  enrichingPhone: boolean
  onEnrichPhone: () => void
  phoneEmpty: boolean
}) {
  const fullName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || '(unnamed)'
  const hasLi = !!(lead.liSummary || (lead.liPosts && lead.liPosts.length > 0))
  const addedLabel = addedAt ? formatAddedAt(addedAt, addedAtApprox) : null
  // Show the Enrich button on any lead with an apolloId that still lacks
  // a verified email OR a LinkedIn URL - the two things Apollo's enrichment
  // actually adds. If both are present, enrichment has nothing to give.
  const needsEnrich = !!lead.apolloId && (!lead.email || !lead.linkedinUrl) && !lead.enriched
  // Show the Get-phone button when we don't already have a phone on this lead
  // AND there's an apolloId to look up. Hidden once a phone is on file.
  const needsPhone = !!lead.apolloId && !lead.phone
  // Transient "copied!" flash for the collapsed-card email badge.
  const [emailCopied, setEmailCopied] = useState(false)
  return (
    <Card className={GLASS}>
      <div className="flex items-stretch">
        <button
          onClick={onToggle}
          className="flex-1 text-left p-3 hover:bg-muted/30 transition-colors min-w-0"
        >
        <div className="flex items-start gap-3">
          {expanded ? <IconChevronDown className="h-4 w-4 mt-1 text-muted-foreground shrink-0" /> : <IconChevronRight className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{fullName}</span>
              {lead.title && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-xs text-muted-foreground">{lead.title}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2.5 mt-1 text-xs text-muted-foreground flex-wrap">
              <LeadStatusBadges
                email={lead.email}
                phone={lead.phone}
                linkedinUrl={lead.linkedinUrl}
                phoneChecking={enrichingPhone}
              />
              {lead.vertical && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5">{lead.vertical}</Badge>
              )}
              {lead.email && (
                <Badge
                  variant="secondary"
                  role="button"
                  title={emailCopied ? 'Copied!' : `Click to copy ${lead.email}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    navigator.clipboard?.writeText(lead.email!)
                      .then(() => { setEmailCopied(true); setTimeout(() => setEmailCopied(false), 1200) })
                      .catch(() => { /* clipboard blocked */ })
                  }}
                  className="text-[10px] h-4 px-1.5 gap-0.5 cursor-pointer hover:bg-sky-500/20"
                >
                  <IconMail className="h-2.5 w-2.5" /> {emailCopied ? 'copied!' : 'email'}
                </Badge>
              )}
              {lead.linkedinUrl && (
                <Badge
                  variant="default"
                  role="link"
                  title={lead.linkedinUrl}
                  onClick={(e) => { e.stopPropagation(); window.open(lead.linkedinUrl!, '_blank', 'noopener,noreferrer') }}
                  className="text-[10px] h-4 px-1.5 gap-0.5 cursor-pointer bg-blue-600/90 hover:bg-blue-600 text-white"
                >
                  <IconBrandLinkedin className="h-2.5 w-2.5" /> LinkedIn
                </Badge>
              )}
              {lead.phone && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 gap-0.5">
                  <IconPhone className="h-2.5 w-2.5" /> phone
                </Badge>
              )}
              {!lead.phone && lead.hasPhone && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-4 px-1.5 gap-0.5"
                  title="Apollo's search response hinted this contact has a phone. Click Get phone to fetch it."
                >
                  <IconPhone className="h-2.5 w-2.5" /> phone available
                </Badge>
              )}
              {hasLi && (
                <Badge variant="default" className="text-[10px] h-4 px-1.5 gap-0.5 bg-sky-500/80 hover:bg-sky-500/80">
                  <IconCheck className="h-2.5 w-2.5" /> LI cached
                </Badge>
              )}
              {lead.enriched && (
                <Badge variant="default" className="text-[10px] h-4 px-1.5 gap-0.5 bg-emerald-500/80 hover:bg-emerald-500/80">
                  <IconCheck className="h-2.5 w-2.5" /> Enriched
                </Badge>
              )}
              {addedLabel && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-4 px-1.5 gap-0.5"
                  title={
                    addedAt
                      ? `${new Date(addedAt).toLocaleString()}${addedAtApprox ? ' (approximate - using company creation date as fallback)' : ''}`
                      : undefined
                  }
                >
                  <IconCalendar className="h-2.5 w-2.5" /> {addedLabel}
                </Badge>
              )}
            </div>
          </div>
        </div>
        </button>
        <div className="flex items-center gap-2 pr-3 shrink-0">
          {/* Company name - first row, right side, left of the action
              buttons. Bold + sky so the rep can scan which company a lead
              belongs to at a glance. Truncates so long names don't crowd
              the buttons. */}
          {lead.companyDomain ? (
            <a
              href={`https://${lead.companyDomain.replace(/^https?:\/\//, '')}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 max-w-[180px] text-xs font-semibold text-sky-700 dark:text-sky-300 hover:underline"
              title={lead.companyName || lead.companyDomain}
            >
              <IconBuilding className="h-3 w-3 text-sky-600 dark:text-sky-400 shrink-0" />
              <span className="truncate">{lead.companyName || lead.companyDomain}</span>
            </a>
          ) : (
            <span
              className="flex items-center gap-1 max-w-[180px] text-xs font-semibold text-sky-700 dark:text-sky-300"
              title={lead.companyName || ''}
            >
              <IconBuilding className="h-3 w-3 text-sky-600 dark:text-sky-400 shrink-0" />
              <span className="truncate">{lead.companyName || '(unknown company)'}</span>
            </span>
          )}
          {(needsEnrich || needsPhone) && (
          <div className="flex items-center gap-1.5">
            {needsEnrich && (
              <Button
                variant="outline"
                size="sm"
                onClick={onEnrich}
                disabled={enriching}
                className="gap-1.5 h-7 text-xs"
                title="Get verified email + LinkedIn URL via Apollo (1 credit)"
              >
                {enriching
                  ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                  : <IconSparkles className="h-3.5 w-3.5" />}
                {enriching ? 'Enriching…' : 'Enrich'}
              </Button>
            )}
            {needsPhone && (
              <Button
                variant="outline"
                size="sm"
                onClick={onEnrichPhone}
                disabled={enrichingPhone}
                className="gap-1.5 h-7 text-xs"
                title="Reveal phone number via Apollo waterfall. Apollo enriches in background (~minutes)."
              >
                {enrichingPhone
                  ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                  : <IconPhone className="h-3.5 w-3.5" />}
                {enrichingPhone ? 'Revealing…' : 'Reveal phone'}
              </Button>
            )}
          </div>
          )}
        </div>
      </div>
      {enrichError && (
        <div className="px-3 pb-2 -mt-1 text-[11px] text-destructive flex items-center gap-1">
          <IconAlertTriangle className="h-3 w-3" /> {enrichError}
        </div>
      )}
      {phoneEmpty && !enrichingPhone && (
        <div className="px-3 pb-2 -mt-1 text-[11px] text-muted-foreground flex items-center gap-1">
          <IconPhone className="h-3 w-3" /> Apollo had no phone on file for this contact.
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 border-t border-border/40 pt-3 space-y-3 text-xs">
          {/* Contact */}
          <div className="grid gap-1">
            {lead.email && (
              <div className="flex items-center gap-1.5">
                <IconMail className="h-3 w-3 text-muted-foreground" />
                <CopyEmail email={lead.email} className="text-foreground" />
                {lead.emailStatus === 'verified' ? (
                  <span title="Verified by Apollo" className="inline-flex">
                    <IconCheck className="h-3 w-3 text-emerald-600" />
                  </span>
                ) : lead.emailStatus ? (
                  <span className="text-muted-foreground">({lead.emailStatus})</span>
                ) : null}
              </div>
            )}
            {lead.phone && (
              <div className="flex items-center gap-1.5">
                <IconPhone className="h-3 w-3 text-muted-foreground" />
                <a href={`tel:${lead.phone}`} className="text-foreground hover:underline">{lead.phone}</a>
              </div>
            )}
            {lead.linkedinUrl && (
              <div className="flex items-center gap-1.5">
                <IconBrandLinkedin className="h-3 w-3 text-muted-foreground" />
                <a href={lead.linkedinUrl} target="_blank" rel="noreferrer" className="text-foreground hover:underline break-all">
                  {lead.linkedinUrl}
                </a>
              </div>
            )}
            {lead.companyDomain && (
              <div className="flex items-center gap-1.5">
                <IconBuilding className="h-3 w-3 text-muted-foreground" />
                <a href={`https://${lead.companyDomain.replace(/^https?:\/\//, '')}`} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
                  {lead.companyDomain}
                </a>
              </div>
            )}
          </div>

          {/* LinkedIn profile */}
          {lead.liSummary && (
            <div className="rounded-md bg-muted/30 p-3 space-y-2">
              <div className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
                LinkedIn profile
                {lead.liScrapedAt && (
                  <span className="ml-2 font-normal lowercase normal-case">
                    · cached {Math.round((Date.now() - lead.liScrapedAt) / (24 * 60 * 60 * 1000))}d ago
                  </span>
                )}
              </div>
              {lead.liSummary.headline && (
                <div className="font-medium">{lead.liSummary.headline}</div>
              )}
              {lead.liSummary.location && (
                <div className="flex items-center gap-1 text-muted-foreground">
                  <IconMapPin className="h-3 w-3" /> {lead.liSummary.location}
                </div>
              )}
              {lead.liSummary.about && (
                <div className="text-muted-foreground leading-relaxed">{lead.liSummary.about}</div>
              )}
              {lead.liSummary.experience && (
                <div>
                  <span className="font-semibold text-muted-foreground">Experience</span>
                  <pre className="whitespace-pre-wrap text-[11px] mt-1 font-sans">{lead.liSummary.experience}</pre>
                </div>
              )}
              {lead.liSummary.recentPromotion && (
                <div className="text-emerald-600 dark:text-emerald-400 font-medium">
                  🎉 Recent promotion: started "{lead.liSummary.recentPromotion.newRole}"
                  at {lead.liSummary.recentPromotion.company}
                  {lead.liSummary.recentPromotion.monthsAgo === 0 ? ' this month' : ` ${lead.liSummary.recentPromotion.monthsAgo}mo ago`}
                  {lead.liSummary.recentPromotion.priorRole && ` (was "${lead.liSummary.recentPromotion.priorRole}")`}
                </div>
              )}
            </div>
          )}

          {/* Recent posts */}
          {Array.isArray(lead.liPosts) && lead.liPosts.length > 0 && (
            <div className="rounded-md bg-muted/30 p-3 space-y-2">
              <div className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px] flex items-center justify-between">
                <span>Recent posts</span>
                <span className="font-normal lowercase">{lead.liPosts.length} scraped</span>
              </div>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                {lead.liPosts.map((p, i) => {
                  const dateLabel = p.date ? String(p.date) : 'date unknown'
                  const parts: string[] = []
                  if ((p.likes ?? 0) > 0) parts.push(`${p.likes} likes`)
                  if ((p.comments ?? 0) > 0) parts.push(`${p.comments} comments`)
                  const meta = [dateLabel, ...parts].join(' · ')
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
            </div>
          )}

          {/* When there's no LI data at all */}
          {!lead.liSummary && (!lead.liPosts || lead.liPosts.length === 0) && (
            <div className="text-muted-foreground italic">
              No cached LinkedIn data. Will be populated next time this lead is sent through email generation.
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// Absolute date/time label for the row chip. Added today → show the time
// (e.g. "2:32 PM") so a vague "today" doesn't hide when in the day it
// landed; older → show the date ("21 May", or "21 May 2025" across years).
// `approx` is true when the timestamp is the company's createdAt (not a
// real per-lead stamp) - we prefix `~` so the operator can tell at a glance.
function formatAddedAt(ts: number, approx: boolean): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  let label: string
  if (sameDay) {
    label = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } else {
    const sameYear = d.getFullYear() === now.getFullYear()
    label = d.toLocaleDateString(
      undefined,
      sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
    )
  }
  return approx ? `~${label}` : label
}
