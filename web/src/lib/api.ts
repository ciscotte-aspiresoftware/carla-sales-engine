// Thin fetch wrappers around the Atlas API. In dev, API_BASE is empty so
// calls stay relative and the Vite dev server proxies /api → localhost:3001
// (see vite.config.ts). In a deployed frontend, API_BASE is the backend's
// public URL (VITE_API_URL) so every call is absolute and cross-origin.
import { API_BASE } from './api-base'
import { safeFetch } from './safe-fetch'

// Contacts harvested from the scraped website markdown (emails, phones,
// LinkedIn URLs). Populated by the sweep pipeline + the classify route.
// Every field is an array because a site can list several. Absent on
// records scraped before this feature, or where nothing was found.
export interface ScrapedContacts {
  emails: string[]
  phones: string[]
  linkedinPersonUrls: string[]
  linkedinCompanyUrls: string[]
  extractedAt?: number
}

export interface Classification {
  // GPT classifier verdict - written by the sweep pipeline and the
  // reclassify flow. is_match is the boolean qualified/rejected decision;
  // reason is the one-sentence rationale shown on the Accounts page.
  // Both are optional so legacy records (pre-this-field) typecheck.
  is_match?: boolean | null
  reason?: string
  // Place data from Scrapingdog Maps - captured on first scrape and
  // surfaced in the UI for the rep's quick scan.
  title?: string
  address?: string
  rating?: number
  // Number of Google Maps reviews. Property collides with the per-ICP
  // `reviews` map on a company, so be careful: this lives on classification,
  // that one on company.
  reviews?: number
  // Rich classification fields - populated by the prompt's structured
  // output. All optional because different verticals' prompts emit
  // different fields (a car-rental ICP populates fleetSizeHint, a garden-
  // centre ICP wouldn't). The UI just renders whichever are present.
  isCarRental?: boolean
  isIndependent?: boolean
  confidence?: 'high' | 'medium' | 'low'
  name?: string
  tagline?: string
  country?: string
  city?: string
  languages?: string[]
  fleetSizeHint?: string
  fleetVehicleTypes?: string[]
  hasOnlineBooking?: boolean
  bookingPlatformHints?: string[]
  phone?: string
  email?: string
  domain?: string
  // Google Maps place_id - captured on the sweep so the UI can deep-link to
  // the Maps listing (used for no-website "needs check" companies).
  placeId?: string
  signals?: string[]
  reasoning?: string
  // GPT-generated markdown report (per-ICP). Present only when the ICP has
  // reports enabled and one has been generated. matched → full template
  // report; rejected → short why-rejected markdown.
  report?: string
  // Set when a rep manually overrode a `not qualified` verdict to qualified
  // via the Sales Agent override popup. is_match is forced true; this flag
  // lets the UI mark it as a human call rather than a model verdict.
  overridden?: boolean
  overriddenAt?: number
  classifiedAt?: number
  // Verbatim excerpts from the scraped page that anchor the verdict + a few
  // short notable facts. Populated by the classifier as part of the SAME GPT
  // call (no extra credit). `sourceUrl` is the scraped page they came from,
  // used to render quotes as clickable links back to where they were found.
  key_quotes?: string[]
  sourceUrl?: string
}

// LinkedIn profile + posts cached on a lead. Populated by the email-gen
// route after the first GPT call. Optional everywhere because not every
// lead has a LinkedIn URL or has been email-genned yet.
export interface LiSummary {
  name?: string
  headline?: string
  about?: string
  location?: string
  current?: string
  experience?: string
  promotions?: string
  lastRoleCompany?: string | null
  hasPresentRole?: boolean
  recentPromotion?: { company: string; newRole: string | null; priorRole: string | null; monthsAgo: number } | null
}
export interface LiPost {
  text: string
  date: string
  likes: number
  comments: number
}

export interface Lead {
  firstName: string
  lastName: string
  title: string
  email: string | null
  emailStatus: string | null
  linkedinUrl: string | null
  hasEmail: boolean
  apolloId: string | null
  // Phone - populated opportunistically by /enrich (same Apollo call as email)
  // OR by /enrich-phone (explicit re-check). May still be null if Apollo had
  // no phone on file for this contact (mobile reveal would need the paid
  // webhook flow).
  phone?: string | null
  phoneCheckedAt?: number
  // Pre-enrich phone availability hint extracted from Apollo's search
  // response (no extra credit). True = Apollo gave us a signal the contact
  // has a phone. False/undefined = unknown - could still have one, would
  // need to enrich to find out. Don't treat as "definitely no phone".
  hasPhone?: boolean
  // Search-only leads start as enriched=false. After /api/email enriches
  // them once, the response carries enriched=true and the same row in
  // companies.json is updated, so reloads keep the badge.
  enriched?: boolean
  enrichedAt?: number
  // LinkedIn cache - set by /api/email after the first scrape for this
  // lead. Fresh for 30 days; re-scraped after that on the next email gen.
  liSummary?: LiSummary | null
  liPosts?: LiPost[]
  liScrapedAt?: number
  // Stamped by attachLeads on first insert. Older leads (pre-stamp) won't
  // have this - UI falls back to companyCreatedAt with a `~` prefix.
  addedAt?: number
}

// Returned by GET /api/leads - Lead + flat company-context fields tacked
// on so the database UI can render company/vertical chips per row.
export interface LeadRecord extends Lead {
  companyId: string
  companyName: string | null
  companyDomain: string | null
  vertical: string | null
  icpIds: string[]
  // Fallback "added" date for legacy leads that don't have their own
  // addedAt yet - the company's createdAt is the earliest possible date
  // the lead could have been attached.
  companyCreatedAt: number | null
}

export interface FetchAllLeadsFilters {
  vertical?: string
  icp?: string
  portfolioCompany?: string
  companyId?: string
  hasLi?: boolean
  hasEmail?: boolean
  search?: string
}

export interface GeneratedEmail {
  subject: string
  body: string
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  // safeFetch wraps the raw fetch with a one-time auto-retry on Render
  // cold-start symptoms (empty 502/503, network failures). Same behaviour as
  // a plain fetch when the backend is warm; just resilient when it isn't.
  const res = await safeFetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // Read once as text so we can surface a useful error if the backend
  // returned HTML (e.g. 404 page from a typo'd route).
  const raw = await res.text()
  let data: any
  try { data = JSON.parse(raw) }
  catch {
    throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`)
  }
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `Request failed (HTTP ${res.status})`)
  }
  return data as T
}

// Classify a URL against ONE specific ICP. icpId is required - there is no
// generic classifier. If this ICP already has a stored verdict for the
// company, it's served instantly (fromStored=true, no scrape/GPT) unless
// force=true. Otherwise the disk scrape-cache is reused when present
// (fromCache=true), so re-analyzing a known company is GPT-only.
export function classifyUrl(url: string, icpId: string, force = false) {
  return postJson<{
    success: true
    companyId?: string
    icpId: string
    classification: Classification
    contacts?: ScrapedContacts
    fromCache?: boolean
    fromStored?: boolean
  }>('/api/classify', { url, icpId, force })
}

// Manually override a `not qualified` verdict to qualified for one ICP.
// Flips classifications[icpId].is_match → true and stamps overridden:true.
// Used by the Sales Agent's not-qualified popup.
export function overrideClassification(companyId: string, icpId: string) {
  return getJson<{ success: true; company: CompanyRecord }>(
    `/api/companies/${encodeURIComponent(companyId)}/override-classification`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icpId }),
    },
  )
}

export function fetchLeads(args: { companyName: string; domain: string; limit?: number; companyId?: string; skipEnrich?: boolean }) {
  return postJson<{ success: true; people: Lead[]; warnings: string[] }>('/api/leads', args)
}

// Single-person Apollo enrichment for a lead already in companies.json.
// Used by the Leads page's row-level "Enrich" button. Returns the updated
// lead so the caller can splice it into place without a full refetch.
export function enrichLead(companyId: string, apolloId: string) {
  return postJson<{ success: true; lead: Lead; demo?: boolean }>(
    `/api/leads/${encodeURIComponent(companyId)}/${encodeURIComponent(apolloId)}/enrich`,
    {},
  )
}

// Phone-only re-check. Same Apollo call under the hood, but only the phone
// field is persisted - leaves email/LI untouched. `phoneFound` tells the UI
// whether Apollo actually had a phone on file (false = "we tried, nothing").
export function enrichLeadPhone(companyId: string, apolloId: string) {
  return postJson<{ success: true; lead: Lead; phoneFound: boolean; demo?: boolean }>(
    `/api/leads/${encodeURIComponent(companyId)}/${encodeURIComponent(apolloId)}/enrich-phone`,
    {},
  )
}

export function generateEmail(args: {
  classification: Classification
  lead: Lead
  companyId?: string
  templateId?: string  // explicit template pick - takes priority
  icpId?: string       // for auto-suggest when no templateId is provided
  senderId?: string    // legacy - kept for paste-classify flow
}) {
  return postJson<{
    success: true
    email: GeneratedEmail
    lead: Lead // possibly-enriched copy of the lead - overwrites the row in the UI
    sender: { id: string; name: string; signoff: string }
    template: { id: string; name: string; portfolioCompany: string; language: string } | null
    warnings: string[]
  }>('/api/email', args)
}

// ─── LI Message (paste-URL or pick-from-leads → scrape → email) ────────

export function liMessageScrape(args: {
  linkedinUrl?: string
  companyId?: string
  apolloId?: string
}) {
  return postJson<{
    success: true
    profileSummary: LiSummary | null
    posts: LiPost[]
    lead?: Lead
    companyName?: string | null
    cached?: boolean
    cacheAgeDays?: number
    demo?: boolean
  }>('/api/li-message/scrape', args)
}

export function liMessageEmail(args: {
  profileSummary: LiSummary | null
  posts: LiPost[]
  linkedinUrl?: string
  icpId?: string
  templateId?: string
  senderId?: string
  companyId?: string
  apolloId?: string
  classification?: Classification | null
  customInstruction?: string
}) {
  return postJson<{
    success: true
    email: GeneratedEmail
    lead: Lead
    sender: { id: string; name: string; signoff: string }
    template: { id: string; name: string; portfolioCompany: string; language: string } | null
    warnings: string[]
  }>('/api/li-message/email', args)
}

// ─── Sourcing (Scrapingdog Maps) ───────────────────────────────────────

export interface SourcingCity {
  key: string
  label: string
  country: string
  domain: string
  language: string
  ll: string
  lat: number
  lng: number
}

export interface SourcingPoint {
  lat: number
  lng: number
  label?: string
}

export interface SourcingResult {
  title: string
  placeId: string
  dataId: string
  website: string
  domain: string
  phone: string
  address: string
  rating: number | null
  reviews: number | null
  primaryType: string
  allTypes: string[]
  description: string
  hours: string
  gps: { latitude: number; longitude: number } | null
  thumbnail: string
}

export interface SourcingScanCounts {
  totalRaw: number
  keptCount: number
  chainsFiltered: number
  nonTargetFiltered: number
}

export interface SourcingScanSummary {
  id: string
  city: string
  country: string
  query: string
  page: number
  ranAt: number
  totalRaw: number
  keptCount: number
  chainsFiltered: number
  nonTargetFiltered: number
}

export interface PlaceDetailsTrimmed {
  title: string
  rating: number | null
  reviews: number | null
  ratingSummary: Array<{ stars: number; amount: number }>
  phone: string
  address: string
  types: string[]
  serviceOptions: Record<string, boolean | string>
  extensions: Array<Record<string, string[]>>
  unsupportedExtensions: Array<Record<string, string[]>>
  gps: { latitude: number; longitude: number } | null
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  // See note on postJson above - same cold-start-resilient wrapper.
  const res = await safeFetch(API_BASE + path, { credentials: 'include', ...(init || {}) })
  const raw = await res.text()
  let data: any
  try { data = JSON.parse(raw) }
  catch {
    throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`)
  }
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `Request failed (HTTP ${res.status})`)
  }
  return data as T
}

export function fetchSourcingCities() {
  return getJson<{ success: true; cities: SourcingCity[] }>('/api/sourcing/cities')
}

export interface SearchSourcingArgs {
  cityKey?: string
  point?: SourcingPoint
  query?: string
  page?: number
}

export function searchSourcing(args: SearchSourcingArgs) {
  return postJson<{
    success: true
    scanId: string
    results: SourcingResult[]
    counts: SourcingScanCounts
    target: { label: string; country: string; ll: string }
  }>('/api/sourcing/search', args)
}

export function getPlaceDetails(args: { dataId: string }) {
  return postJson<{
    success: true
    details: PlaceDetailsTrimmed
    cached: boolean
    fetchedAt?: number
  }>('/api/sourcing/details', args)
}

export function promoteToSalesAgent(args: { result: SourcingResult; scanId?: string }) {
  return postJson<{
    success: true
    companyId: string
    url: string
    alreadyExisted: boolean
  }>('/api/sourcing/promote', args)
}

export function fetchSourcingScans() {
  return getJson<{ success: true; scans: SourcingScanSummary[] }>('/api/sourcing/scans')
}

// ─── Database (companies.json) ─────────────────────────────────────────

// Sales-rep review of a pre-classified company under one ICP. Stored as
// `company.reviews[icpId]`. Reviews are per-ICP because the same company
// can be the right fit for ICP A and clearly wrong for ICP B even when
// both ICPs share a vertical.
export interface Review {
  decision: 'confirmed' | 'rejected'
  reason?: string | null
  note?: string | null
  reviewedAt: number
}

export interface CompanyRecord {
  id: string
  url: string
  domain: string
  // Vertical the company was discovered under - set on first sweep, sticky.
  // Drives the database page's vertical filter and the reclassify-existing
  // flow ("which other ICPs in the same vertical can I run on this?").
  vertical?: string | null
  // City where the cell that found this company was anchored. Used by the
  // coverage-status endpoint to answer "is this city already covered?".
  city?: string | null
  // Latest classification, pinned by upsertCompany to whichever ICP wrote
  // it most recently. Kept for legacy display surfaces; the canonical
  // store is `classifications` below.
  classification: Classification
  // Per-ICP verdicts. Each ICP that has classified this company has its
  // own entry. New in v2 of the data model - empty/undefined for legacy
  // records (the migration on read in the API populates this from the
  // single `classification` field when possible).
  classifications?: Record<string, Classification & { classifiedAt?: number }>
  // Per-ICP sales-rep reviews (confirm/reject). Absent until the rep has
  // weighed in on this account.
  reviews?: Record<string, Review>
  scrapedAt: number              // 0 means seeded but never classified (e.g. promoted from sourcing)
  // String form is the canonical sweep-source ("bluebird:London:demo");
  // older code used an object shape - kept as union for compat with the
  // sourcing-promotion path until that's migrated to the same string form.
  source:
    | string
    | {
        type: string
        scanId?: string | null
        dataId?: string | null
        placeId?: string | null
        promotedAt?: number
      }
    | null
  // Lat/lng captured from Scrapingdog Maps (`gps_coordinates`). null for
  // paste-classified records or anything that didn't go through the sweep
  // pipeline. Drives the map view on the Database page.
  location?: { lat: number; lng: number } | null
  // Contacts scraped from the company website. null/absent when nothing
  // was found or the record predates the feature.
  scrapedContacts?: ScrapedContacts | null
  createdAt: number
  updatedAt: number
  leads: Array<Lead & { enriched?: boolean; enrichedAt?: number }>
  leadsUpdatedAt?: number
}

// Filters supported by GET /api/companies. All optional; AND-combined.
// reviewStatus is only meaningful when an icp is also set - reviews are
// per-ICP, so 'pending' / 'confirmed' / 'rejected' depend on which ICP.
export interface FetchCompaniesFilters {
  vertical?: string
  icp?: string
  match?: boolean
  portfolioCompany?: string
  reviewStatus?: 'pending' | 'confirmed' | 'rejected' | 'needs-check'
}

export function fetchCompanies(filters: FetchCompaniesFilters = {}) {
  const params = new URLSearchParams()
  if (filters.vertical) params.set('vertical', filters.vertical)
  if (filters.icp) params.set('icp', filters.icp)
  if (typeof filters.match === 'boolean') params.set('match', String(filters.match))
  if (filters.portfolioCompany) params.set('portfolioCompany', filters.portfolioCompany)
  if (filters.reviewStatus) params.set('reviewStatus', filters.reviewStatus)
  const qs = params.toString()
  return getJson<{ success: true; companies: CompanyRecord[] }>(
    qs ? `/api/companies?${qs}` : '/api/companies',
  )
}

// Generate (or refresh) the markdown report for one company under one ICP.
// Backfill path - reads the cached scrape server-side, no re-scrape. The
// ICP must have a verdict on this company already (matched → full report,
// rejected → why-rejected). Returns the updated company + the report.
export function generateReport(companyId: string, icpId: string) {
  return getJson<{ success: true; company: CompanyRecord; report: string }>(
    `/api/companies/${encodeURIComponent(companyId)}/generate-report`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icpId }),
    },
  )
}

// Submit a sales-rep review. `reason` is the canned-reason slug picked
// from the dropdown; `note` is the optional free-text. Both are stored
// verbatim on the company record under reviews[icpId].
export function submitReview(
  companyId: string,
  icpId: string,
  payload: { decision: 'confirmed' | 'rejected'; reason?: string; note?: string },
) {
  return getJson<{ success: true; company: CompanyRecord }>(
    `/api/companies/${encodeURIComponent(companyId)}/reviews/${encodeURIComponent(icpId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
}

// Undo a review - moves the account back to the Pending lane.
export function clearReview(companyId: string, icpId: string) {
  return getJson<{ success: true; company: CompanyRecord }>(
    `/api/companies/${encodeURIComponent(companyId)}/reviews/${encodeURIComponent(icpId)}`,
    { method: 'DELETE' },
  )
}

export function fetchVerticals() {
  return getJson<{ success: true; verticals: string[] }>('/api/companies/verticals')
}

// GET /api/leads - flat list of every stored lead across all companies,
// each row enriched with company context (id/name/domain/vertical/icpIds)
// so the leads database can render company chips without a join. Mirrors
// the filter dimensions of fetchCompanies plus a couple of lead-specific
// ones (hasLi / hasEmail / free-text search).
export function fetchAllLeads(filters: FetchAllLeadsFilters = {}) {
  const params = new URLSearchParams()
  if (filters.vertical) params.set('vertical', filters.vertical)
  if (filters.icp) params.set('icp', filters.icp)
  if (filters.portfolioCompany) params.set('portfolioCompany', filters.portfolioCompany)
  if (filters.companyId) params.set('companyId', filters.companyId)
  if (typeof filters.hasLi === 'boolean') params.set('hasLi', String(filters.hasLi))
  if (typeof filters.hasEmail === 'boolean') params.set('hasEmail', String(filters.hasEmail))
  if (filters.search) params.set('search', filters.search)
  const qs = params.toString()
  return getJson<{ success: true; leads: LeadRecord[] }>(
    qs ? `/api/leads?${qs}` : '/api/leads',
  )
}

// Distinct portfolioCompany strings across ICPs - drives the Portfolio
// Company filter dropdown on Coverage / Database pages. Returns an empty
// list if no ICP has a portfolioCompany set.
export function fetchPortfolioCompanies() {
  return getJson<{ success: true; portfolioCompanies: string[] }>('/api/icps/portfolio-companies')
}

// ─── Email templates ──────────────────────────────────────────────────
// Per-portfolio-company sender + system-prompt records that drive
// outbound email generation. Replaces the old hardcoded-sender flow so
// each portfolio company (Bluebird, Thermeon, NedFox) has its own voice.

export interface EmailTemplateSender {
  firstName: string
  lastName?: string
  title?: string
  company?: string
  email?: string
  signoff: string
}

// 'email' = outbound email templates (the original use case); 'linkedin' =
// LinkedIn DM templates surfaced on the /li-message page. Defaults to 'email'
// for any record returned by an older backend that doesn't know the field.
export type TemplateChannel = 'email' | 'linkedin'

export interface EmailTemplateSummary {
  id: string
  name: string
  portfolioCompany: string
  channel: TemplateChannel
  defaultForIcps: string[]   // ICP ids that auto-use this template
  language: string
  sender: EmailTemplateSender
}

export interface EmailTemplate extends EmailTemplateSummary {
  voice: string
  systemPrompt: string
  // Optional portfolio-specific guidance on how to use LinkedIn signals.
  // Appended to the LI signals block in the prompt (after the universal
  // rules baked into the prompt builder). Free text - typical usage is a
  // sentence or two about which post types to prefer / avoid.
  linkedinGuidance?: string
  exampleSubject?: string
  exampleBody?: string
  createdAt?: number
  updatedAt?: number
}

export function fetchEmailTemplates(filters: { portfolioCompany?: string; channel?: TemplateChannel } = {}) {
  const params = new URLSearchParams()
  if (filters.portfolioCompany) params.set('portfolioCompany', filters.portfolioCompany)
  if (filters.channel) params.set('channel', filters.channel)
  const qs = params.toString()
  return getJson<{ success: true; templates: EmailTemplateSummary[] }>(`/api/email-templates${qs ? `?${qs}` : ''}`)
}

export function fetchEmailTemplate(id: string) {
  return getJson<{ success: true; template: EmailTemplate }>(`/api/email-templates/${encodeURIComponent(id)}`)
}

// Auto-pick a template for a given ICP. Used on the Email Gen page when
// the rep arrives via the My Accounts skip flow - we want the ICP's
// bound template pre-selected rather than making the rep pick every
// time. portfolioCompany is a soft fallback for ICPs that haven't been
// explicitly bound to a template yet.
export function suggestEmailTemplate(opts: { icp?: string; portfolioCompany?: string; channel?: TemplateChannel }) {
  const params = new URLSearchParams()
  if (opts.icp) params.set('icp', opts.icp)
  if (opts.portfolioCompany) params.set('portfolioCompany', opts.portfolioCompany)
  if (opts.channel) params.set('channel', opts.channel)
  const qs = params.toString()
  return getJson<{ success: true; template: EmailTemplate | null }>(`/api/email-templates/suggest${qs ? `?${qs}` : ''}`)
}

export function createEmailTemplate(payload: Partial<EmailTemplate>) {
  return getJson<{ success: true; template: EmailTemplate }>(`/api/email-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function updateEmailTemplate(id: string, payload: Partial<EmailTemplate>) {
  return getJson<{ success: true; template: EmailTemplate }>(`/api/email-templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function deleteEmailTemplate(id: string) {
  return getJson<{ success: true }>(`/api/email-templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// ─── ICP reclassify + coverage status ──────────────────────────────────

export interface IcpCoverageRow {
  city: string
  covered: boolean
  cachedCompanies: number
  alreadyClassifiedByThisIcp: number
  toReclassify: number
}

export interface IcpCoverageSummary {
  totalCities: number
  coveredCities: number
  newCities: number
  totalCachedCompanies: number
  totalToReclassify: number
}

// Stale-sweep diff returned from /coverage. Tells the Coverage page:
//   • how many already-completed cells have new search terms unrun
//   • which specific terms would hit Scrapingdog on the targeted rescan
// (run by POST /icps/:id/rescan-stale-terms - search_log dedup means only
// the NEW terms get Maps'd, not the entire term-set per cell again).
export interface IcpStaleSweep {
  stale: number
  completed: number
  newTermsByCell: Record<string, string[]>
  newTerms: string[]
}

export function fetchIcpCoverage(icpId: string, cities?: string[]) {
  const qs = cities && cities.length > 0 ? `?cities=${encodeURIComponent(cities.join(','))}` : ''
  return getJson<{
    success: true
    vertical: string | null
    summary: IcpCoverageSummary
    breakdown: IcpCoverageRow[]
    staleSweep: IcpStaleSweep
  }>(`/api/icps/${encodeURIComponent(icpId)}/coverage${qs}`)
}

export function rescanStaleTerms(icpId: string) {
  return getJson<{ success: true; rescanned: number; newTerms: string[] }>(
    `/api/icps/${encodeURIComponent(icpId)}/rescan-stale-terms`,
    { method: 'POST' },
  )
}

export interface ReclassifySummary {
  vertical: string
  inputs: number
  processed: number
  qualified: number
  rejected: number
  skipped: number
  errors: number
}

export function reclassifyIcp(icpId: string, opts: { cities?: string[]; force?: boolean } = {}) {
  return getJson<{ success: true; summary: ReclassifySummary }>(
    `/api/icps/${encodeURIComponent(icpId)}/reclassify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    },
  )
}
