// /discover - standalone "find + enrich + contacts" tool built for the Aspire
// CRM integration. Independent of the per-company / All-Companies workspaces:
// you give it search terms + a location + dynamic criteria, it runs
// Scrapingdog Maps → Firecrawl + GPT → Apollo, and returns CRM-ready records
// you can download as JSON (whole batch or per company).
//
// This page only talks to POST /api/discover. It writes nothing to Atlas's
// own stores - the output is meant to be imported into the CRM.

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Loader2, Download, Search, MapPin, CheckCircle2, XCircle, ExternalLink, Users,
} from 'lucide-react'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-base'
import { Markdown } from '@/components/ui/markdown'

interface DiscoverContact {
  name: string
  title: string
  email: string | null
  emailStatus: string | null
  linkedinUrl: string | null
  phone: string | null
}

interface DiscoverRecord {
  company: string
  website: string
  domain: string
  address: string
  city: string
  country: string
  phone: string
  rating: number | null
  reviews: number | null
  category: string
  gps: { latitude: number; longitude: number } | null
  source: string
  searchTerm: string
  qualified: boolean | null
  reason: string | null
  summary: string
  attributes: Record<string, unknown>
  signals: string[]
  report: string | null
  websiteContacts: { emails: string[]; phones: string[]; linkedinPersonUrls: string[]; linkedinCompanyUrls: string[] } | null
  contacts: DiscoverContact[]
}

interface DiscoverMeta {
  location: string
  country: string
  searchTerms: string[]
  requested: number
  found: number
  returned: number
  enrich: boolean
  contacts: boolean
  report: boolean
  ranAt: number
}

// Trigger a browser download of `data` as pretty-printed JSON.
function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Trigger a browser download of arbitrary text (used for the markdown report).
function downloadText(filename: string, text: string, mime = 'text/markdown') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function slug(s: string) {
  return (s || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'company'
}

export default function DiscoverPage() {
  const [searchTermsText, setSearchTermsText] = useState('boutique hotels, luxury resorts')
  const [location, setLocation] = useState('Lisbon, Portugal')
  const [criteria, setCriteria] = useState(
    'Independent hotels and lodges that run their own front desk. Extract room count, current PMS / booking software, and star rating. Exclude large international chains.',
  )
  const [limit, setLimit] = useState(8)
  const [contactsLimit, setContactsLimit] = useState(3)
  const [enrich, setEnrich] = useState(true)
  const [contacts, setContacts] = useState(true)
  const [report, setReport] = useState(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [records, setRecords] = useState<DiscoverRecord[] | null>(null)
  const [meta, setMeta] = useState<DiscoverMeta | null>(null)

  const run = async () => {
    setLoading(true)
    setError(null)
    setRecords(null)
    setMeta(null)
    try {
      const terms = searchTermsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      if (terms.length === 0) throw new Error('Enter at least one search term')
      if (!location.trim()) throw new Error('Enter a location')
      // Send the discover API key if one is baked into the build. Lets the
      // Atlas page keep working after you turn on DISCOVER_API_KEY on the
      // backend. (Note: a key in the frontend bundle is only light protection
      // - the real secret is the copy the CRM team keeps server-side.)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const apiKey = import.meta.env.VITE_DISCOVER_API_KEY
      if (apiKey) headers['x-api-key'] = apiKey
      const res = await fetch(`${API_BASE}/api/discover`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          searchTerms: terms,
          location: location.trim(),
          limit,
          criteria,
          enrich,
          contacts,
          report,
          contactsLimit,
        }),
      })
      const raw = await res.text()
      let data: any
      try { data = JSON.parse(raw) } catch { throw new Error(`Server returned non-JSON (HTTP ${res.status})`) }
      if (!res.ok || data?.success === false) throw new Error(data?.error || `Request failed (HTTP ${res.status})`)
      setRecords(data.records || [])
      setMeta(data.meta || null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <Search className="h-6 w-6 text-sky-500" />
          <h1 className="text-2xl font-semibold">Discover (CRM)</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-2 max-w-3xl">
          Find fresh leads for the CRM: Scrapingdog Maps finds businesses for your search terms in a
          location, Firecrawl + GPT scrape and analyze each site against your criteria, and Apollo pulls
          decision-maker contacts. Download the result as JSON (whole batch or per company) to import
          into the CRM. Nothing is saved into Atlas.
        </p>
      </div>

      {/* ── Form ───────────────────────────────────────────────────────── */}
      <Card className={GLASS}>
        <CardContent className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Search terms (comma or newline separated)</span>
              <Input
                value={searchTermsText}
                onChange={(e) => setSearchTermsText(e.target.value)}
                placeholder="boutique hotels, luxury resorts"
                className="mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Location</span>
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Lisbon, Portugal"
                className="mt-1"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Criteria (drives GPT analysis + what to extract)</span>
            <textarea
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm"
              placeholder="What qualifies a company, and what facts should we extract?"
            />
          </label>

          <div className="flex flex-wrap items-end gap-4">
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Limit (companies)</span>
              <Input
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)))}
                className="mt-1 w-28"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Contacts / company</span>
              <Input
                type="number"
                min={1}
                max={10}
                value={contactsLimit}
                onChange={(e) => setContactsLimit(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
                className="mt-1 w-28"
                disabled={!contacts}
              />
            </label>
            <label className="flex items-center gap-2 text-sm pb-2">
              <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
              Enrich (Firecrawl + GPT)
            </label>
            <label className="flex items-center gap-2 text-sm pb-2">
              <input type="checkbox" checked={contacts} onChange={(e) => setContacts(e.target.checked)} />
              Apollo contacts
            </label>
            <label className="flex items-center gap-2 text-sm pb-2" title="Ask GPT for a markdown writeup per company (Overview / Fit / Outreach angle). Requires Enrich.">
              <input type="checkbox" checked={report} onChange={(e) => setReport(e.target.checked)} disabled={!enrich} />
              GPT report (markdown)
            </label>
            <div className="ml-auto pb-1">
              <Button onClick={run} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Search className="h-4 w-4 mr-1.5" />}
                {loading ? 'Discovering…' : 'Run discovery'}
              </Button>
            </div>
          </div>

          {!enrich && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Enrich off → fast Scrapingdog-only results (name / website / phone / address). No GPT analysis.
            </p>
          )}
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Running the pipeline - Scrapingdog → Firecrawl + GPT → Apollo. This can take a minute or two for larger limits.
        </div>
      )}

      {/* ── Results ────────────────────────────────────────────────────── */}
      {records && meta && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">
              <b>{meta.returned}</b> records · {meta.location} · {meta.found} found ·{' '}
              {meta.searchTerms.join(', ')}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={records.length === 0}
              onClick={() => downloadJson(`discover-${slug(meta.location)}-${meta.ranAt}.json`, { meta, records })}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download all (JSON)
            </Button>
          </div>

          {records.length === 0 && (
            <p className="text-sm text-muted-foreground">No results - try broader search terms or a different location.</p>
          )}

          {records.map((r, i) => (
            <Card key={`${r.domain || r.company}-${i}`} className={GLASS}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{r.company || '(no name)'}</span>
                      {r.qualified === true && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" /> qualified
                        </span>
                      )}
                      {r.qualified === false && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400">
                          <XCircle className="h-3.5 w-3.5" /> rejected
                        </span>
                      )}
                      {r.category && <span className="text-[11px] text-muted-foreground">· {r.category}</span>}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                      {r.website && (
                        <a href={/^https?:\/\//i.test(r.website) ? r.website : `https://${r.website}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
                          <ExternalLink className="h-3 w-3" /> {r.domain || r.website}
                        </a>
                      )}
                      {r.phone && <span>{r.phone}</span>}
                      {r.address && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{r.address}</span>}
                      {r.rating != null && <span>★ {r.rating}{r.reviews != null ? ` (${r.reviews})` : ''}</span>}
                    </div>

                    {r.summary && <p className="text-sm mt-2">{r.summary}</p>}
                    {r.reason && <p className="text-xs text-muted-foreground mt-1 italic">{r.reason}</p>}

                    {/* Dynamic attributes from the criteria-driven analysis */}
                    {r.attributes && Object.keys(r.attributes).length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {Object.entries(r.attributes)
                          .filter(([, v]) => v !== null && v !== '' && v !== undefined)
                          .map(([k, v]) => (
                            <span key={k} className="text-[11px] rounded bg-muted/50 px-1.5 py-0.5">
                              <span className="text-muted-foreground">{k}:</span> {String(v)}
                            </span>
                          ))}
                      </div>
                    )}

                    {/* Apollo contacts */}
                    {r.contacts.length > 0 && (
                      <div className={cn(GLASS_SUBTLE, 'mt-3 rounded-md p-2 space-y-1')}>
                        <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                          <Users className="h-3 w-3" /> {r.contacts.length} contact{r.contacts.length !== 1 ? 's' : ''}
                        </div>
                        {r.contacts.map((c, ci) => (
                          <div key={ci} className="text-xs flex flex-wrap items-center gap-x-2">
                            <span className="font-medium">{c.name || '(name n/a)'}</span>
                            {c.title && <span className="text-muted-foreground">{c.title}</span>}
                            {c.email && <span className="text-sky-600 dark:text-sky-400">{c.email}</span>}
                            {c.phone && <span>{c.phone}</span>}
                            {c.linkedinUrl && (
                              <a href={c.linkedinUrl} target="_blank" rel="noreferrer" className="text-sky-600 dark:text-sky-400">in</a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* GPT markdown report (only when the report toggle was on) */}
                    {r.report && (
                      <details className="mt-3 group">
                        <summary className="cursor-pointer text-[11px] font-medium text-sky-600 dark:text-sky-400 select-none">
                          GPT report
                        </summary>
                        <div className={cn(GLASS_SUBTLE, 'mt-2 rounded-md p-3 max-h-96 overflow-y-auto text-sm')}>
                          <Markdown source={r.report} />
                          <div className="mt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[11px] px-2"
                              onClick={() => downloadText(`${slug(r.company)}.md`, r.report || '')}
                            >
                              <Download className="h-3 w-3 mr-1" /> Download .md
                            </Button>
                          </div>
                        </div>
                      </details>
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    title="Download this company as JSON"
                    onClick={() => downloadJson(`${slug(r.company)}.json`, r)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
