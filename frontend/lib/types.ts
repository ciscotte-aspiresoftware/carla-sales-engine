/** Per-field source map. Values:
 *   "snippet"      — Tavily-confirmed during discovery (verifiable)
 *   "training"     — Claude training-knowledge estimate (unverified)
 *   "user"         — manually entered/edited by a human
 *   "scrape"       — confirmed by the WebsiteEnrichmentAgent against the live site
 *   "needs_review" — system saw the value but couldn't auto-confirm it
 *                    (currently used for website_url when lite verification
 *                    fell short — soft fail like a name token mismatch)
 *   "unknown"      — no info either way
 * Missing field key = legacy data from before provenance tracking shipped.
 */
export type ProvenanceSource = "snippet" | "training" | "user" | "scrape" | "needs_review" | "unknown"
export type ProvenanceMap = Partial<Record<
  "capacity_count" | "website_url" | "tech_maturity_score" | "has_online_booking" | "services" | "ownership_type" | "email",
  ProvenanceSource
>>

export interface ProspectContact {
  id: number
  prospect_id: number
  full_name: string
  role: string | null
  email: string | null
  phone: string | null
  linkedin_url: string | null
  is_primary: boolean
  contact_priority: number
  provenance: Record<string, ProvenanceSource> | null
  created_at: string | null
}

export interface Prospect {
  id: number
  /** Vertical-neutral. Pack JSON's prospect_schema_hints.size_field_label
   * gives the human-friendly label for the active vertical (e.g. "Marina"
   * for marinas, "Operator" for car rentals). */
  business_name: string
  contact_name: string
  contact_title: string
  email: string
  /** Primary phone. Additional contacts may carry their own phone numbers
   * (see `contacts`). */
  phone: string | null
  city: string
  country_code: string
  /** Vertical-neutral capacity. Pack JSON's industry_context.terminology
   * .size_field_label / .size_field_short give the label per vertical
   * (Berths, Fleet, etc.). */
  capacity_count: number | null
  services: string[] | null
  website_url: string | null
  tech_maturity_score: number | null
  has_online_booking: boolean
  ownership_type: string
  vertical: string
  icp_score: number | null
  research_profile: ResearchProfile | null
  /** Structured payload from the WebsiteEnrichmentAgent. `null` until a
   * scrape has been run. See `WebsiteResearch` below. */
  website_research: WebsiteResearch | null
  provenance: ProvenanceMap | null
  lat: number | null
  lng: number | null
  is_real: boolean
  created_at: string | null
  /** Additional personas (owner + GM + dockmaster, etc.). Empty when only
   * the primary contact exists. */
  contacts: ProspectContact[]
}

export interface ResearchProfile {
  hook_line: string
  pain_hypothesis: string
  credible_detail: string
  suggested_persona: string
  personalization_notes: string
  icp_reasoning?: string
}

export interface WebsiteResearchKeyQuote {
  quote: string
  source_url: string
}

/** Email address found on the scraped pages. `score` is a sort key used to
 * order candidates in the UI — higher = better fit for the contact role.
 * `kind` is "mailto" (from a curated <a href="mailto:..."> link, strongest)
 * or "text" (regex match in visible page text). */
export interface DiscoveredEmail {
  email: string
  source_url: string
  context: string
  score: number
  kind: "mailto" | "text" | string
  /** Result of the lightweight MX/A DNS check on this address's domain.
   * `true` = the domain can receive mail; `false` = no MX + no A record,
   * NXDOMAIN, or DNS error. `null` / undefined = check wasn't run. */
  deliverable?: boolean | null
  /** Slug: "deliverable" | "no_mx" | "unknown_domain" | "dns_error" |
   *  "bad_format" | "unchecked". */
  deliverability_status?: string
  /** Short human-readable reason (e.g. "MX → mx1.example.com" or "NXDOMAIN"). */
  deliverability_detail?: string | null
}

export interface WebsiteResearchMeta {
  provider: string | null
  robots_allowed: boolean | null
  pages_fetched: string[]
  fetched_at: string
  scrape_version: number
  verification_confidence?: number
  canonical_url?: string | null
  /** "scrape" = full multi-page scrape + LLM extraction.
   *  "verification" = lite URL check only — no services / quotes / etc.
   *  Default (undefined) is "scrape" for backwards compat with payloads
   *  saved before the lite check existed. */
  kind?: "scrape" | "verification"
  /** Set on lite verification records when the URL itself is broken
   * (HTTP error, parked, unreachable) — discovery uses this to decide
   * whether to null the URL or just flag for review. */
  is_hard_fail?: boolean
}

/** Per-item source attribution. For each extracted fact list, maps the
 * item's verbatim string to the URL of the page it was sighted on.
 * `has_online_booking` is a single fact so its source is a bare URL.
 * Missing entries simply mean "no per-item source recorded" — older
 * scrapes won't carry this map and the UI degrades gracefully. */
export interface WebsiteResearchEvidence {
  services_list: Record<string, string>
  pain_signals: Record<string, string>
  competitors_mentioned: Record<string, string>
  tech_stack_signals: Record<string, string>
  has_online_booking: string | null
}

export interface WebsiteResearch {
  verified: boolean
  /** Short slug indicating outcome: "ok" / "name_mismatch" / "parked_domain"
   * / "http_error" / "empty_page" / "empty_url" / "provider_unavailable". */
  reason?: string
  message?: string
  /** Set to "robots_txt" when the homepage robots.txt disallowed inner-page
   * fetching after verification passed. */
  scrape_blocked?: string | null
  summary: string | null
  services_list: string[]
  has_online_booking: boolean | null
  online_booking_url: string | null
  tech_stack_signals: string[]
  pain_signals: string[]
  competitors_mentioned: string[]
  key_quotes: WebsiteResearchKeyQuote[]
  /** Per-item source attribution. Optional for backwards compat with
   * scrapes saved before evidence tracking shipped. */
  evidence?: WebsiteResearchEvidence
  /** Every email address the agent found on the scraped pages, sorted
   * best-first by deterministic scoring. The agent never invents emails;
   * an empty list means the site didn't expose any. */
  discovered_emails: DiscoveredEmail[]
  /** The single best candidate Claude picked for this prospect's contact
   * role. Always one of the addresses in `discovered_emails` (or null). */
  recommended_email: string | null
  recommended_email_rationale: string | null
  meta: WebsiteResearchMeta
}

export interface WebsiteScrapeStatus {
  step: string   // "idle" | "queued" | "verifying" | "fetching" | "saving" | "complete"
  message: string
}

export interface WebsiteScrapeOptions {
  max_pages?: number
  preferred_keywords?: string[]
}

export interface WebsiteScrapeBatchResponse {
  started: number
  enqueued_ids: number[]
  skipped_ids: number[]
  options: WebsiteScrapeOptions
}

export interface ProspectListResponse {
  prospects: Prospect[]
  total: number
  page: number
  limit: number
  pages: number
}

export interface CampaignStats {
  enrolled: number
  emails_generated: number
  pending_approval: number
  approved: number
  sent: number
  opens: number
  clicks: number
  replies: number
  meetings_booked: number
  open_rate: number
  reply_rate: number
}

export type CampaignCadence =
  | "immediate"
  | "next_business_day_9am"
  | "weekly_tuesday_10am"
  | "custom"

export interface Campaign {
  id: number
  name: string
  vertical_pack: string
  vendor_pack: string | null
  product_pack: string | null
  regional_pack: string
  status: string
  sequence_touches: number
  touch_delay_days: number
  icp_filter: unknown | null
  campaign_brief_id: string | null
  campaign_brief_title: string | null
  /** Schedule + tools (Roadmap Phases 4 + 5). Defaults preserve existing
   * demo flows: manual approval, no A/B, no dry-run. */
  auto_send: boolean
  send_cadence: CampaignCadence
  cadence_custom_cron: string | null
  ab_test: boolean
  dry_run: boolean
  created_at: string | null
  stats: CampaignStats | null
}

export interface CampaignListResponse {
  campaigns: Campaign[]
  total: number
}

export interface EmailSequence {
  id: number
  campaign_id: number
  prospect_id: number
  touch_number: number
  subject: string
  body: string
  persona_target: string | null
  approval_status: string
  sent_at: string | null
  approved_by: string | null
  approved_at: string | null
  agent_metadata: {
    hook_line?: string
    pain_hypothesis?: string
    credible_detail?: string
    send_after_days?: number
  } | null
  created_at: string | null
  business_name: string | null
  contact_name: string | null
  contact_email: string | null
  /** Prospect's website URL — surfaced on the email review page so the user
   * can open the operator's actual site and fact-check the email's claims. */
  website_url: string | null
}

export interface SequenceListResponse {
  sequences: EmailSequence[]
  total: number
}

export interface ActivityEvent {
  id: number
  campaign_id: number | null
  prospect_id: number | null
  email_sequence_id: number | null
  event_type: string
  event_data: Record<string, unknown> | null
  is_simulated: boolean
  occurred_at: string
  business_name: string | null
  campaign_name: string | null
}

export interface DashboardMetrics {
  emails_sent: number
  open_rate: number
  click_rate: number
  reply_rate: number
  meetings_booked: number
  campaigns_active: number
  funnel: {
    prospects: number
    contacted: number
    replied: number
    meetings: number
  }
}

export type DiscoveryStep =
  | "idle"
  | "generating"
  | "ready_for_review"   // wizard: candidates returned, user reviewing before verify
  | "verifying"
  | "enriching"
  | "saving"
  | "complete"
  | "error"

export interface DiscoveryEvent {
  ts: string         // ISO timestamp
  step: DiscoveryStep
  message: string
  found: number
  total: number
}

export interface DiscoveryStatus {
  step: DiscoveryStep
  message: string
  found: number
  total: number
  data_source?: "tavily" | "claude_knowledge" | null
  tavily_available?: boolean
  prospect_ids?: number[]
  // Categorised skip counts — backend tracks these separately so the UI can show
  // a precise reason instead of guessing from (total - found).
  skipped_no_contact?: number
  skipped_excluded?: number
  skipped_duplicate?: number
  // Persistent transcript — every set_progress call is appended here so the
  // UI can render a scrollable history of what happened during the run.
  events?: DiscoveryEvent[]
}

export interface DiscoveryResult {
  status: string
  location: string
}

// ── Wizard (interactive discovery) ────────────────────────────────────────────

export type SizePreference = "any" | "small_independent" | "established"

export type DiscoveryConfidence = "high" | "medium" | "low"

export interface DiscoveryCandidate {
  business_name: string
  city: string
  country_code: string
  estimated_capacity: number | null
  guessed_website: string | null
  guessed_ownership_type: string | null
  // Claude's honest confidence that this entity exists at this location.
  // The wizard surfaces this as a chip so the user can prune low-confidence
  // rows before they cost Tavily tokens.
  confidence: DiscoveryConfidence | null
  // One short phrase Claude uses to describe what this operator is known for.
  // Display-only — not consumed by the enrich step.
  notable_for: string | null
  // Pre-computed Tavily query for this candidate. The wizard surfaces this so
  // the user can see / edit it before /enrich-save runs.
  planned_query: string
}

export interface DiscoveryGenerateResponse {
  candidates: DiscoveryCandidate[]
  skipped_excluded: number
  size_preference: SizePreference
  size_focus: string
  tavily_available: boolean
}

export interface DiscoverySuggestCountResponse {
  suggested: number
  reasoning: string
}

export interface DiscoveryEnrichSaveResponse {
  status: string
  candidate_count: number
}

export interface OutreachSender {
  name: string
  email: string
}

export interface Pack {
  pack_id: string
  pack_type?: "vertical" | "vendor" | "product" | "regional"
  pack_layout?: "legacy" | "layered"
  display_name: string
  product_name?: string
  product_url?: string
  logo_color?: string
  vertical_id?: string
  vendor_id?: string
  product_id?: string
  /** Vertical-only: which vendor's pack should be pre-selected for this vertical
   * in the campaign creator. Set this in the JSON to override the default (the
   * first vendor alphabetically). */
  default_vendor_id?: string
  // Set on legacy single-file packs (e.g. marina). Layered packs put it on vendor.outreach_sender.
  outreach_sender?: OutreachSender
  industry_context?: {
    summary?: string
    key_kpis?: string[]
    common_pains?: string[]
    buyer_segments?: Array<{ id: string; label: string; description: string }>
    default_unit_label?: string
    default_metric_label?: string
    /** Vertical-specific copy used by frontend labels and the discovery prompts.
     * Authored once per vertical pack — see backend/packs/vertical/marina.json
     * or car_rental.json for the canonical shape. */
    terminology?: {
      entity_label?: string
      entity_label_singular?: string
      size_field_label?: string
      size_field_short?: string
      default_contact_role?: string
      default_ownership_type?: string
      fallback_email_domain?: string
    }
    discovery_copy?: {
      industry_expert_role?: string
      ownership_options?: string[]
      search_suffix?: string
      contact_priority?: string
      service_options?: string[]
      tech_maturity_hint?: string
      size_focus_label?: string
      country_code_examples?: string
      mix_guidance?: string
    }
    size_band_thresholds?: {
      mid_min?: number
      large_min?: number
    }
    ui?: {
      color_token?: string
      logo_color?: string
    }
  }
  icp?: {
    description?: string
    minimum_score?: number
    criteria: Array<{
      field: string
      operator: string
      value: unknown
      weight: number
      label: string
    }>
  }
  vendor?: VendorPack
  scope_summary?: string
  modules?: string[]
  personas?: Record<string, {
    titles: string[]
    primary_motivators: string[]
    communication_style: string
    value_props: string[]
    objection_handles?: Record<string, string>
  }>
  messaging_framework?: {
    elevator_pitch: string
    differentiators: string[]
    proof_points?: Array<string | Record<string, unknown>>
  }
  email_guidance?: {
    sequence_strategy: string
    cta_progression: string[]
    avoid: string[]
  }
}

export interface VendorPack {
  pack_id: string
  pack_type?: "vendor"
  company_name: string
  display_name?: string
  parent_company?: string
  portfolio_group?: string
  logo_color?: string
  version?: string
  /** Pre-selected product when this vendor is chosen in the campaign creator.
   * Overrides the default (first product alphabetically). Set in vendor JSON. */
  default_product_id?: string
  verticals?: string[]
  headquarters?: string
  regional_offices?: string[]
  regions_served?: string
  years_in_business?: string
  company_summary?: string
  primary_url?: string
  customer_logos?: Array<{ name: string; geography?: string }>
  support_model?: string
  brand_voice?: {
    tone?: string
    avoid?: string[]
    favored_phrasing?: string[]
  }
  outreach_sender?: OutreachSender
  excluded_customers?: Array<{ name: string; reason?: string } | string>
  /** Competitor names the website-enrichment agent flags when found verbatim
   * on a prospect's site. Aggregated across every vendor pack targeting the
   * prospect's vertical. Edit via Pack Explorer → vendor panel. */
  competitor_signals?: string[]
  product_ids?: string[]
}

export interface ProductPack extends Pack {
  pack_type?: "product"
  vendor_id: string
  vertical_id: string
  product_name: string
}

export interface PacksListResponse {
  vertical: string[]
  vendor: string[]
  product: string[]
  regional: string[]
}

/** Minimal metadata for the sidebar / vertical-switcher. Sourced from
 * pack JSON's `industry_context.ui` — adding a new vertical = pack JSON,
 * no code change. */
export interface VerticalManifestEntry {
  id: string
  label: string
  color_token: string | null
  logo_color: string | null
  /** Optional pack-declared catalog of capabilities this vertical wants to
   * advertise. `null` = pack didn't opt-in (UI shows everything). When
   * provided, channel rows for capabilities not listed here can be hidden
   * on a vertical-aware page. Capability values mirror the backend's
   * Capability enum (`email_send`, `voice_call`, etc.). */
  supported_capabilities: string[] | null
}

/** One setting row, as the Settings page consumes it. Secret values are
 * ALWAYS masked server-side — `value_preview` is safe to display. */
export interface AppSettingEntry {
  key: string
  label: string
  description: string
  category: "api_keys" | "branding" | "display" | "general" | string
  is_secret: boolean
  env_var: string | null
  placeholder: string
  configured: boolean
  source: "db" | "env" | "unset"
  value_preview: string
}


// ── LLM cost tracking ─────────────────────────────────────────────────────────

export interface ModelPricing {
  model_id: string
  label: string
  input_per_mtok: number
  output_per_mtok: number
  cache_read_per_mtok: number
  cache_write_5m_per_mtok: number
  notes: string
}

export interface AgentMeta {
  name: string
  label: string
  description: string
  // Backend-driven recommendation: which model would be the right pick for this
  // agent given quality / cost trade-offs. Shown as a chip with a one-click
  // apply action when the current selection differs.
  recommended_model?: string
  recommendation_reason?: string
}

export interface LLMSettings {
  active_model: string
  available_models: ModelPricing[]
  // Per-agent model overrides. Maps agent.name → model_id. Agents without an
  // entry here use active_model. Sent by /settings/llm.
  overrides: Record<string, string>
  // Canonical list of agents whose model can be overridden. Backend-driven so
  // adding a new agent just requires one entry in llm_settings.KNOWN_AGENTS.
  agents: AgentMeta[]
}

export interface CurrencyPayload {
  base: string                    // always "USD"
  rates: Record<string, number>   // { USD: 1, EUR: 0.92, GBP: 0.78, ... }
  as_of: string                   // ISO date
  source: string
}

export interface CostWindow {
  cost_usd: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  thinking_tokens: number
  calls: number
}

export interface CostSummary {
  all_time: CostWindow
  last_7d: CostWindow
  last_30d: CostWindow
}

export interface CostBreakdownRow {
  cost_usd: number
  tokens: number
  calls: number
  // One of these is set depending on the breakdown axis
  model?: string
  agent?: string
  campaign_id?: number | null
  campaign_name?: string | null
}

export interface CostDailyRow {
  date: string         // ISO date
  cost_usd: number
  tokens: number
  calls: number
}

/** One day's spend split by model. From /costs/daily-by-model — the stacked
 * chart on the Costs page. */
export interface CostDailyByModelRow {
  date: string
  by_model: Record<string, number>      // model_id → cost_usd
  calls_by_model: Record<string, number> // model_id → calls
}

export interface CostDailyByModelResponse {
  days: CostDailyByModelRow[]
  models: string[]   // ordered by total spend desc
}

/** p50 / p95 / call count of duration_ms per agent. From /costs/latency-by-agent. */
export interface AgentLatencyRow {
  agent: string
  p50_ms: number
  p95_ms: number
  calls: number
  total_ms: number
}

export interface LLMCall {
  id: number
  occurred_at: string | null
  model: string
  agent: string
  campaign_id: number | null
  campaign_name: string | null
  prospect_id: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  thinking_tokens: number
  cost_usd: number
  duration_ms: number | null
}
