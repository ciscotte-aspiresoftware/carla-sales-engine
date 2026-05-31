const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api/v1"

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`API error ${res.status}: ${error}`)
  }
  return res.json()
}

export const api = {
  // Prospects
  getProspects: (params?: Record<string, string | number | boolean | undefined>) => {
    const q = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") q.set(k, String(v))
      })
    }
    const qs = q.toString()
    return request<import("./types").ProspectListResponse>(`/prospects${qs ? `?${qs}` : ""}`)
  },
  getProspect: (id: number) => request<import("./types").Prospect>(`/prospects/${id}`),
  updateProspect: (id: number, data: Partial<import("./types").Prospect>) =>
    request<import("./types").Prospect>(`/prospects/${id}`, {
      method: "PATCH", body: JSON.stringify(data),
    }),

  // Prospect contacts (additional personas per prospect)
  listProspectContacts: (prospectId: number) =>
    request<import("./types").ProspectContact[]>(`/prospects/${prospectId}/contacts`),
  createProspectContact: (
    prospectId: number,
    data: Partial<import("./types").ProspectContact>,
  ) =>
    request<import("./types").ProspectContact>(`/prospects/${prospectId}/contacts`, {
      method: "POST", body: JSON.stringify(data),
    }),
  updateProspectContact: (
    prospectId: number,
    contactId: number,
    data: Partial<import("./types").ProspectContact>,
  ) =>
    request<import("./types").ProspectContact>(`/prospects/${prospectId}/contacts/${contactId}`, {
      method: "PATCH", body: JSON.stringify(data),
    }),
  deleteProspectContact: (prospectId: number, contactId: number) =>
    request<{ deleted: boolean; id: number }>(`/prospects/${prospectId}/contacts/${contactId}`, {
      method: "DELETE",
    }),

  runResearch: (id: number) =>
    request<{ status: string; prospect_id: number }>(`/agents/research/${id}`, { method: "POST" }),
  getResearchStatus: (id: number) =>
    request<{ step: string; message: string }>(`/agents/research/${id}/status`),

  /** Kick off a website scrape for one prospect. Background task — poll
   * `getWebsiteScrapeStatus` for progress. `options.max_pages` is clamped
   * to [1, 5] server-side; `options.preferred_keywords` is optional. */
  runWebsiteScrape: (id: number, options?: import("./types").WebsiteScrapeOptions) =>
    request<{ status: string; prospect_id: number; options: import("./types").WebsiteScrapeOptions }>(
      `/agents/website-scrape/${id}`,
      { method: "POST", body: JSON.stringify(options ?? {}) },
    ),
  getWebsiteScrapeStatus: (id: number) =>
    request<import("./types").WebsiteScrapeStatus>(`/agents/website-scrape/${id}/status`),
  /** Batch scrape — caps at 25 prospect_ids per call server-side. Returns the
   * count actually enqueued (prospects without a website_url are skipped). */
  runWebsiteScrapeBatch: (
    ids: number[],
    options?: import("./types").WebsiteScrapeOptions,
  ) =>
    request<import("./types").WebsiteScrapeBatchResponse>("/agents/website-scrape/batch", {
      method: "POST",
      body: JSON.stringify({ prospect_ids: ids, ...(options ?? {}) }),
    }),

  /** Promote one of `website_research.discovered_emails` to be the prospect's
   * primary email. Backend rejects (400) if the address isn't in that list,
   * (409) if another prospect already has it. Flips provenance.email →
   * "scrape" and logs a `prospect_email_updated` activity event. */
  adoptDiscoveredEmail: (id: number, email: string) =>
    request<import("./types").Prospect>(`/prospects/${id}/use-discovered-email`, {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  /** Lite URL check for a batch of prospects — confirms each `website_url`
   * still resolves and plausibly belongs to the business. Synchronous (no
   * LLM call), caps at 50 IDs per call server-side. Returns per-prospect
   * outcome + a summary count. */
  verifyWebsitesBatch: (ids: number[]) =>
    request<{
      summary: { verified: number; needs_review: number; broken: number; no_url: number; errored: number }
      results: Array<{ prospect_id: number; status: string; verified: boolean; reason?: string }>
    }>("/agents/verify-websites/batch", {
      method: "POST",
      body: JSON.stringify({ prospect_ids: ids }),
    }),
  /** Synchronous batch ICP scoring. Returns once the prospector finishes —
   * typically 5–10s for a batch of 8. Persists icp_score + icp_reasoning. */
  scoreProspects: (ids: number[]) =>
    request<{ scores: Array<{ prospect_id: number; icp_score: number; icp_reasoning: string }> }>(
      "/agents/score-prospects",
      { method: "POST", body: JSON.stringify({ prospect_ids: ids }) },
    ),

  // Campaigns
  getCampaigns: (params?: { status?: string; vertical?: string }) => {
    const q = new URLSearchParams()
    if (params?.status) q.set("status", params.status)
    if (params?.vertical) q.set("vertical", params.vertical)
    const qs = q.toString()
    return request<import("./types").CampaignListResponse>(`/campaigns${qs ? `?${qs}` : ""}`)
  },
  getCampaign: (id: number) => request<import("./types").Campaign>(`/campaigns/${id}`),
  createCampaign: (data: unknown) =>
    request<import("./types").Campaign>("/campaigns", { method: "POST", body: JSON.stringify(data) }),
  updateCampaign: (id: number, data: unknown) =>
    request<import("./types").Campaign>(`/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  runPipeline: (id: number) =>
    request<{ status: string; campaign_id: number }>(`/campaigns/${id}/run-pipeline`, { method: "POST" }),
  getCampaignStats: (id: number) =>
    request<import("./types").CampaignStats>(`/analytics/campaigns/${id}`),
  getPipelineStatus: (id: number) =>
    request<{ step: string; message: string; done: number; total: number }>(`/campaigns/${id}/pipeline-status`),

  // Sequences
  getSequences: (params?: { campaign_id?: number; prospect_id?: number; approval_status?: string }) => {
    const q = new URLSearchParams()
    if (params?.campaign_id) q.set("campaign_id", String(params.campaign_id))
    if (params?.prospect_id) q.set("prospect_id", String(params.prospect_id))
    if (params?.approval_status) q.set("approval_status", params.approval_status)
    const qs = q.toString()
    return request<import("./types").SequenceListResponse>(`/sequences${qs ? `?${qs}` : ""}`)
  },
  approveSequence: (id: number) =>
    request<import("./types").EmailSequence>(`/sequences/${id}/approve`, { method: "PATCH" }),
  rejectSequence: (id: number) =>
    request<import("./types").EmailSequence>(`/sequences/${id}/reject`, { method: "PATCH" }),
  bulkApprove: (ids: number[]) =>
    request<{ approved: number }>("/sequences/bulk-approve", {
      method: "POST",
      body: JSON.stringify({ ids, approved_by: "demo_user" }),
    }),
  bulkReject: (ids: number[]) =>
    request<{ rejected: number }>("/sequences/bulk-reject", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  updateSequenceContent: (id: number, subject: string, body: string) =>
    request<import("./types").EmailSequence>(`/sequences/${id}/content`, {
      method: "PATCH",
      body: JSON.stringify({ subject, body }),
    }),
  markSent: (id: number) =>
    request<import("./types").EmailSequence>(`/sequences/${id}/mark-sent`, { method: "POST" }),

  // Packs
  getPacks: () => request<import("./types").PacksListResponse>("/packs"),
  /** Lightweight manifest of available verticals (id, label, color_token,
   * logo_color). Drives the sidebar / vertical switcher without needing to
   * load every full pack on boot. */
  getVerticalsManifest: () =>
    request<{ verticals: import("./types").VerticalManifestEntry[] }>("/verticals/manifest"),

  // Settings — one row per known engine setting with masked secret values.
  getAppSettings: () =>
    request<{ settings: import("./types").AppSettingEntry[] }>("/settings"),
  setAppSetting: (key: string, value: string) =>
    request<{ settings: import("./types").AppSettingEntry[] }>(`/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteAppSetting: (key: string) =>
    request<{ settings: import("./types").AppSettingEntry[] }>(`/settings/${key}`, {
      method: "DELETE",
    }),
  getVerticalPack: (id: string) => request<import("./types").Pack>(`/packs/vertical/${id}`),
  getVendorPack: (id: string) => request<import("./types").VendorPack>(`/packs/vendor/${id}`),
  getProductPack: (id: string) => request<import("./types").ProductPack>(`/packs/product/${id}`),
  getRegionalPack: (id: string) => request<import("./types").Pack>(`/packs/regional/${id}`),
  /**
   * Compose a vertical with a vendor + product into a single pack object.
   * Legacy verticals (marina) accept just the vertical id; layered verticals
   * (car_rental) require vendor and product.
   */
  getComposedPack: (vertical: string, vendor?: string, product?: string) => {
    const q = new URLSearchParams({ vertical })
    if (vendor) q.set("vendor", vendor)
    if (product) q.set("product", product)
    return request<import("./types").Pack>(`/packs/composed?${q.toString()}`)
  },
  createVerticalPack: (data: unknown) =>
    request<import("./types").Pack>("/packs/vertical", { method: "POST", body: JSON.stringify(data) }),
  updateVerticalPack: (id: string, data: unknown) =>
    request<import("./types").Pack>(`/packs/vertical/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteVerticalPack: (id: string) =>
    request<void>(`/packs/vertical/${id}`, { method: "DELETE" }),
  createVendorPack: (data: unknown) =>
    request<import("./types").VendorPack>("/packs/vendor", { method: "POST", body: JSON.stringify(data) }),
  updateVendorPack: (id: string, data: unknown) =>
    request<import("./types").VendorPack>(`/packs/vendor/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteVendorPack: (id: string) =>
    request<void>(`/packs/vendor/${id}`, { method: "DELETE" }),
  createProductPack: (data: unknown) =>
    request<import("./types").ProductPack>("/packs/product", { method: "POST", body: JSON.stringify(data) }),
  updateProductPack: (id: string, data: unknown) =>
    request<import("./types").ProductPack>(`/packs/product/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProductPack: (id: string) =>
    request<void>(`/packs/product/${id}`, { method: "DELETE" }),
  generateRegionalPack: (country: string) =>
    request<Record<string, unknown>>("/packs/regional/generate", { method: "POST", body: JSON.stringify({ country }) }),
  /**
   * Generate one section of a pack with Claude. Section is one of:
   *   "icp"        — ICP scoring criteria array (vertical pack)
   *   "personas"   — buyer personas dict        (product pack)
   *   "messaging"  — messaging framework        (product pack)
   *   "email_guidance" — email sequence guidance (product pack)
   * Pass vertical_id / vendor_id / product_id to load saved pack context;
   * pass `draft` to bias the generation with unsaved edits.
   */
  generatePackSection: (req: {
    section: "icp" | "personas" | "messaging" | "email_guidance"
    vertical_id?: string
    vendor_id?: string
    product_id?: string
    draft?: Record<string, unknown>
    instructions?: string
  }) =>
    request<Record<string, unknown>>("/packs/generate-section", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  createRegionalPack: (data: unknown) =>
    request<Record<string, unknown>>("/packs/regional", { method: "POST", body: JSON.stringify(data) }),
  updateRegionalPack: (id: string, data: unknown) =>
    request<Record<string, unknown>>(`/packs/regional/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  // Activity
  getActivity: (params?: { campaign_id?: number; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.campaign_id) q.set("campaign_id", String(params.campaign_id))
    if (params?.limit) q.set("limit", String(params.limit))
    const qs = q.toString()
    return request<{ events: import("./types").ActivityEvent[] }>(`/activity${qs ? `?${qs}` : ""}`)
  },
  // Analytics
  getDashboard: () => request<import("./types").DashboardMetrics>("/analytics/dashboard"),
  getRegionBreakdown: () => request<{ regions: Array<{ country_code: string; count: number }> }>("/analytics/by-region"),

  // Holidays
  getHolidays: (country_code: string, year: number) =>
    request<{ holidays: string[] }>(`/holidays/${country_code}/${year}`),

  // Campaign Briefs
  createCampaignBrief: (data: unknown) =>
    request<unknown>("/sdr/campaign-briefs", { method: "POST", body: JSON.stringify(data) }),
  getCampaignBriefs: () => request<unknown>("/sdr/campaign-briefs"),

  // Demo — wipes campaigns / sequences / activity / briefs and clears AI research.
  // Prospects are preserved. Engagement counters return to zero (no re-seeding).
  resetDemo: () => request<{
    status: string
    campaigns_deleted: number
    campaign_prospects_deleted: number
    sequences_deleted: number
    activity_events_deleted: number
    campaign_briefs_deleted: number
  }>("/demo/reset", { method: "POST" }),

  // Guardrails
  getGuardrails: () => request<{ rules: string[]; notes: string }>("/guardrails"),
  updateGuardrails: (rules: string[], notes: string) =>
    request<{ rules: string[]; notes: string }>("/guardrails", {
      method: "PUT",
      body: JSON.stringify({ rules, notes }),
    }),

  // ── LLM Costs + Settings ────────────────────────────────────────────────
  getLLMSettings: () => request<import("./types").LLMSettings>("/settings/llm"),
  setActiveModel: (model_id: string) =>
    request<{ active_model: string }>("/settings/llm/active-model", {
      method: "PUT",
      body: JSON.stringify({ model_id }),
    }),
  /** Pin an agent to a specific model, or pass model_id=null to clear the
   * override (agent reverts to the global active_model). */
  setAgentModel: (agent: string, model_id: string | null) =>
    request<{ overrides: Record<string, string> }>("/settings/llm/agent-model", {
      method: "PUT",
      body: JSON.stringify({ agent, model_id }),
    }),
  getCostSummary: () => request<import("./types").CostSummary>("/costs/summary"),
  getCostByModel: () => request<{ rows: import("./types").CostBreakdownRow[] }>("/costs/by-model"),
  getCostByAgent: () => request<{ rows: import("./types").CostBreakdownRow[] }>("/costs/by-agent"),
  getCostByCampaign: () => request<{ rows: import("./types").CostBreakdownRow[] }>("/costs/by-campaign"),
  getCostDaily: (days = 30) =>
    request<{ days: import("./types").CostDailyRow[] }>(`/costs/daily?days=${days}`),
  getCostDailyByModel: (days = 30) =>
    request<import("./types").CostDailyByModelResponse>(`/costs/daily-by-model?days=${days}`),
  getLatencyByAgent: () =>
    request<{ rows: import("./types").AgentLatencyRow[] }>("/costs/latency-by-agent"),
  getRecentLLMCalls: (limit = 50) =>
    request<{ calls: import("./types").LLMCall[] }>(`/costs/recent?limit=${limit}`),
  getCurrencyRates: () => request<import("./types").CurrencyPayload>("/costs/currency-rates"),

  // Discovery — legacy one-shot
  startDiscovery: (
    location: string,
    countryCode: string,
    maxResults: number,
    mode: string = "auto",
    segmentType: string = "car_rental",
    includeLowConfidence: boolean = false,
    sizePreference: import("./types").SizePreference = "any",
  ) =>
    request<import("./types").DiscoveryResult>("/agents/discover", {
      method: "POST",
      body: JSON.stringify({
        location,
        country_code: countryCode,
        max_results: maxResults,
        mode,
        segment_type: segmentType,
        include_low_confidence: includeLowConfidence,
        size_preference: sizePreference,
      }),
    }),
  getDiscoveryStatus: () =>
    request<import("./types").DiscoveryStatus>("/agents/discover/status"),

  // Discovery — wizard endpoints
  suggestDiscoveryCount: (
    location: string,
    countryCode: string,
    segmentType: string,
    sizePreference: import("./types").SizePreference,
  ) =>
    request<import("./types").DiscoverySuggestCountResponse>("/agents/discover/suggest-count", {
      method: "POST",
      body: JSON.stringify({
        location,
        country_code: countryCode,
        segment_type: segmentType,
        size_preference: sizePreference,
      }),
    }),
  generateDiscoveryCandidates: (
    location: string,
    countryCode: string,
    maxResults: number,
    segmentType: string,
    sizePreference: import("./types").SizePreference,
  ) =>
    request<import("./types").DiscoveryGenerateResponse>("/agents/discover/generate", {
      method: "POST",
      body: JSON.stringify({
        location,
        country_code: countryCode,
        max_results: maxResults,
        segment_type: segmentType,
        size_preference: sizePreference,
      }),
    }),
  enrichSaveDiscoveryCandidates: (
    location: string,
    candidates: import("./types").DiscoveryCandidate[],
    mode: string,
    segmentType: string,
    includeLowConfidence: boolean,
    skippedExcluded: number,
  ) =>
    request<import("./types").DiscoveryEnrichSaveResponse>("/agents/discover/enrich-save", {
      method: "POST",
      body: JSON.stringify({
        location,
        candidates,
        mode,
        segment_type: segmentType,
        include_low_confidence: includeLowConfidence,
        skipped_excluded: skippedExcluded,
      }),
    }),
}
