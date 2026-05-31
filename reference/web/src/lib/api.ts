// Thin fetch wrappers around the Bluebird API. Vite dev server proxies
// /api → http://localhost:3001 (see vite.config.ts), so these calls work
// without absolute URLs.

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
  signals?: string[]
  reasoning?: string
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
  // Search-only leads start as enriched=false. After /api/email enriches
  // them once, the response carries enriched=true and the same row in
  // companies.json is updated, so reloads keep the badge.
  enriched?: boolean
  enrichedAt?: number
}

export interface GeneratedEmail {
  subject: string
  body: string
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
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

export function classifyUrl(url: string) {
  return postJson<{ success: true; companyId?: string; classification: Classification }>(
    '/api/classify',
    { url }
  )
}

export function fetchLeads(args: { companyName: string; domain: string; limit?: number; companyId?: string; skipEnrich?: boolean }) {
  return postJson<{ success: true; people: Lead[]; warnings: string[] }>('/api/leads', args)
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
  const res = await fetch(path, { credentials: 'include', ...(init || {}) })
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
  reviewStatus?: 'pending' | 'confirmed' | 'rejected'
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

export interface EmailTemplateSummary {
  id: string
  name: string
  portfolioCompany: string
  defaultForIcps: string[]   // ICP ids that auto-use this template
  language: string
  sender: EmailTemplateSender
}

export interface EmailTemplate extends EmailTemplateSummary {
  voice: string
  systemPrompt: string
  exampleSubject?: string
  exampleBody?: string
  createdAt?: number
  updatedAt?: number
}

export function fetchEmailTemplates(filters: { portfolioCompany?: string } = {}) {
  const qs = filters.portfolioCompany ? `?portfolioCompany=${encodeURIComponent(filters.portfolioCompany)}` : ''
  return getJson<{ success: true; templates: EmailTemplateSummary[] }>(`/api/email-templates${qs}`)
}

export function fetchEmailTemplate(id: string) {
  return getJson<{ success: true; template: EmailTemplate }>(`/api/email-templates/${encodeURIComponent(id)}`)
}

// Auto-pick a template for a given ICP. Used on the Email Gen page when
// the rep arrives via the My Accounts skip flow - we want the ICP's
// bound template pre-selected rather than making the rep pick every
// time. portfolioCompany is a soft fallback for ICPs that haven't been
// explicitly bound to a template yet.
export function suggestEmailTemplate(opts: { icp?: string; portfolioCompany?: string }) {
  const params = new URLSearchParams()
  if (opts.icp) params.set('icp', opts.icp)
  if (opts.portfolioCompany) params.set('portfolioCompany', opts.portfolioCompany)
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

export function fetchIcpCoverage(icpId: string, cities?: string[]) {
  const qs = cities && cities.length > 0 ? `?cities=${encodeURIComponent(cities.join(','))}` : ''
  return getJson<{
    success: true
    vertical: string | null
    summary: IcpCoverageSummary
    breakdown: IcpCoverageRow[]
  }>(`/api/icps/${encodeURIComponent(icpId)}/coverage${qs}`)
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
