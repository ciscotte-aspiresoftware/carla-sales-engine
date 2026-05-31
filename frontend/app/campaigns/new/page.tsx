"use client"

import { useState, useEffect, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useVertical } from "@/lib/vertical-context"
import Link from "next/link"
import { api } from "@/lib/api"
import type { Pack, Prospect, PacksListResponse, VendorPack, ProductPack } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import {
  ChevronLeft, ChevronRight, Globe, CheckCircle2,
  Users, Search, Wifi, WifiOff, Brain,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { COUNTRY_NAMES as COUNTRY_NAMES_MAP } from "@/lib/countries"

const REGION_META: Record<string, { flag: string; label: string }> = {
  us_en: { flag: "🇺🇸", label: "United States (English)" },
  nl_nl: { flag: "🇳🇱", label: "Netherlands (Dutch)" },
  au_en: { flag: "🇦🇺", label: "Australia (English)" },
}

const COUNTRY_NAMES = COUNTRY_NAMES_MAP

const steps = ["Name & Prospects", "Sequence Config", "Review & Launch"]

function icpTier(score: number | null) {
  if (score === null) return { label: "—", color: "text-gray-500", tier: "none" }
  const pct = Math.round(score * 100)
  if (pct >= 75) return { label: `${pct}%`, color: "text-emerald-400", tier: "hot" }
  if (pct >= 55) return { label: `${pct}%`, color: "text-sky-400",     tier: "warm" }
  if (pct >= 35) return { label: `${pct}%`, color: "text-yellow-400",  tier: "cold" }
  return           { label: `${pct}%`, color: "text-gray-500",  tier: "out" }
}

export default function NewCampaignPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // ?prospects=1,2,3 lets callers (e.g. the discovery wizard's done view)
  // jump straight here with a pre-selected set. Parsed once on mount.
  const preselectedIds = useMemo(() => {
    const raw = searchParams.get("prospects")
    if (!raw) return null
    const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    return ids.length > 0 ? new Set(ids) : null
  }, [searchParams])
  // ?location=Seattle seeds the prospect-picker search field so the user
  // arrives looking at the rows they just discovered, not the global
  // ICP-sorted list where their selections might be off-screen.
  const preselectedLocation = useMemo(() => {
    return searchParams.get("location")?.trim() ?? ""
  }, [searchParams])

  const { vertical: contextVertical } = useVertical()
  const [step, setStep] = useState(0)
  const [packs, setPacks] = useState<PacksListResponse | null>(null)
  const [allProspects, setAllProspects] = useState<Prospect[]>([])
  const [prospectsLoading, setProspectsLoading] = useState(true)

  // Form state
  const [name, setName] = useState("")
  const [verticalPack, setVerticalPack] = useState(contextVertical || "car_rental")
  // Empty string = "not selected" (Select stays controlled, never undefined).
  const [vendorPack, setVendorPack] = useState<string>("")
  const [productPack, setProductPack] = useState<string>("")
  const [regionalPack, setRegionalPack] = useState("us_en")
  const [touches, setTouches] = useState(3)
  const [delayDays, setDelayDays] = useState(3)
  const [creating, setCreating] = useState(false)

  // Loaded vendor + product + vertical packs (full details, used to filter
  // the cascade and read default_vendor_id / default_product_id fields).
  const [vendors, setVendors] = useState<VendorPack[]>([])
  const [products, setProducts] = useState<ProductPack[]>([])
  const [verticals, setVerticals] = useState<Pack[]>([])
  // Whether the current vertical pack is layered (requires vendor + product) or legacy
  const [verticalIsLayered, setVerticalIsLayered] = useState(false)

  // Prospect selector state
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // Seed the search field from ?location= when coming from discovery so the
  // user immediately sees their newly-saved rows. Falls back to "" otherwise.
  const [filterSearch, setFilterSearch] = useState(preselectedLocation)
  const [filterCountry, setFilterCountry] = useState("all")
  const [filterOwnership, setFilterOwnership] = useState("all")
  const [filterTier, setFilterTier] = useState("all")

  const loadProspects = (vertical: string) => {
    setProspectsLoading(true)
    setAllProspects([])
    setSelected(new Set())
    const verticalFilter = vertical
    api.getProspects({ vertical: verticalFilter, limit: 200 })
      .then((r) => {
        // Sort: pre-selected rows first (in the order they were passed),
        // then everything else by ICP score descending. This ensures
        // discovery-jump users see "their" prospects at the top even if those
        // prospects haven't been ICP-scored yet (which they typically haven't).
        const preselect = preselectedIds ?? new Set<number>()
        const sorted = [...r.prospects].sort((a, b) => {
          const aPicked = preselect.has(a.id)
          const bPicked = preselect.has(b.id)
          if (aPicked !== bPicked) return aPicked ? -1 : 1
          return (b.icp_score ?? 0) - (a.icp_score ?? 0)
        })
        setAllProspects(sorted)
        // If the URL pre-selected prospects (e.g. from the discovery done page),
        // honour that set verbatim — even prospects below the ICP cutoff. Otherwise
        // fall back to the default "warm or hotter" tier seeding.
        if (preselect.size > 0) {
          const available = new Set(sorted.map((p) => p.id))
          const intersected = new Set([...preselect].filter((id) => available.has(id)))
          setSelected(intersected.size > 0 ? intersected : preselect)
        } else {
          const defaultSelected = new Set(
            sorted.filter((p) => (p.icp_score ?? 0) >= 0.55).map((p) => p.id)
          )
          setSelected(defaultSelected)
        }
      })
      .finally(() => setProspectsLoading(false))
  }

  useEffect(() => {
    api.getPacks().then(async (list) => {
      setPacks(list)
      // Load every vendor, product, AND vertical pack in parallel. Verticals
      // are needed so we can read their `default_vendor_id` field — that's
      // what makes "this vertical defaults to Thermeon, not Bluebird" work.
      const [vendorPacks, productPacks, verticalPacks] = await Promise.all([
        Promise.all((list.vendor ?? []).map((id) => api.getVendorPack(id).catch(() => null))),
        Promise.all((list.product ?? []).map((id) => api.getProductPack(id).catch(() => null))),
        Promise.all((list.vertical ?? []).map((id) => api.getVerticalPack(id).catch(() => null))),
      ])
      setVendors(vendorPacks.filter((v): v is VendorPack => v !== null))
      setProducts(productPacks.filter((p): p is ProductPack => p !== null))
      setVerticals(verticalPacks.filter((v): v is Pack => v !== null))
    })
    loadProspects(contextVertical || "car_rental")
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Vendors that target the current vertical
  const vendorsForVertical = useMemo(
    () => vendors.filter((v) => (v.verticals ?? []).includes(verticalPack)),
    [vendors, verticalPack]
  )

  // Products that match the current vendor + vertical
  const productsForVendor = useMemo(
    () => products.filter((p) => p.vendor_id === vendorPack && p.vertical_id === verticalPack),
    [products, vendorPack, verticalPack]
  )

  // When vertical changes: detect if it's layered (has at least one vendor)
  // and pre-select the configured default vendor (or fall back to the first).
  useEffect(() => {
    if (vendors.length === 0) return // metadata not loaded yet
    const layered = vendorsForVertical.length > 0
    setVerticalIsLayered(layered)
    if (layered) {
      // Honour `default_vendor_id` declared on the vertical pack JSON.
      // Falls back to the first vendor only when no default is configured or
      // the configured default isn't actually one of the vendors that target
      // this vertical (stale config).
      const verticalData = verticals.find((v) => v.pack_id === verticalPack)
      const configuredDefault = verticalData?.default_vendor_id
      const defaultIsValid = configuredDefault
        && vendorsForVertical.some((v) => v.pack_id === configuredDefault)
      const fallback = defaultIsValid ? configuredDefault : (vendorsForVertical[0]?.pack_id ?? "")
      setVendorPack((prev) => {
        const stillValid = prev && vendorsForVertical.some((v) => v.pack_id === prev)
        return stillValid ? prev : fallback
      })
    } else {
      setVendorPack("")
      setProductPack("")
    }
  }, [verticalPack, vendors, vendorsForVertical, verticals])

  // When vendor changes: pre-select the configured default product for that
  // vendor (or fall back to the first).
  useEffect(() => {
    if (!vendorPack) {
      setProductPack("")
      return
    }
    if (productsForVendor.length === 0) {
      setProductPack("")
      return
    }
    // Honour `default_product_id` declared on the vendor pack JSON.
    const vendorData = vendors.find((v) => v.pack_id === vendorPack)
    const configuredDefault = vendorData?.default_product_id
    const defaultIsValid = configuredDefault
      && productsForVendor.some((p) => p.pack_id === configuredDefault)
    const fallback = defaultIsValid ? configuredDefault : (productsForVendor[0]?.pack_id ?? "")
    setProductPack((prev) => {
      const stillValid = prev && productsForVendor.some((p) => p.pack_id === prev)
      return stillValid ? prev : fallback
    })
  }, [vendorPack, productsForVendor, vendors])

  // Client-side filter
  const filtered = useMemo(() => {
    return allProspects.filter((p) => {
      if (filterSearch) {
        const q = filterSearch.toLowerCase()
        if (
          !p.business_name.toLowerCase().includes(q) &&
          !p.contact_name.toLowerCase().includes(q) &&
          !p.city.toLowerCase().includes(q) &&
          !p.country_code.toLowerCase().includes(q)
        ) return false
      }
      if (filterCountry !== "all" && p.country_code !== filterCountry) return false
      if (filterOwnership !== "all" && p.ownership_type !== filterOwnership) return false
      if (filterTier !== "all") {
        const tier = icpTier(p.icp_score).tier
        if (filterTier !== tier) return false
      }
      return true
    })
  }, [allProspects, filterSearch, filterCountry, filterOwnership, filterTier])

  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const someFilteredSelected = filtered.some((p) => selected.has(p.id))

  const toggleAll = () => {
    if (allFilteredSelected) {
      setSelected((prev) => { const s = new Set(prev); filtered.forEach((p) => s.delete(p.id)); return s })
    } else {
      setSelected((prev) => { const s = new Set(prev); filtered.forEach((p) => s.add(p.id)); return s })
    }
  }

  const toggle = (id: number) => {
    setSelected((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }

  const countries = useMemo(() => [...new Set(allProspects.map((p) => p.country_code))].sort(), [allProspects])

  const create = async () => {
    if (!name || selected.size === 0) return
    if (verticalIsLayered && !(vendorPack && productPack)) return
    setCreating(true)
    try {
      const campaign = await api.createCampaign({
        name,
        vertical_pack: verticalPack,
        // Convert empty-string sentinel back to null at the API boundary.
        vendor_pack: verticalIsLayered && vendorPack ? vendorPack : null,
        product_pack: verticalIsLayered && productPack ? productPack : null,
        regional_pack: regionalPack,
        sequence_touches: touches,
        touch_delay_days: delayDays,
        prospect_ids: [...selected],
      })
      router.push(`/campaigns/${campaign.id}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div className="flex items-center gap-3">
        <Link href="/campaigns">
          <Button variant="ghost" size="sm" className="text-gray-400 -ml-2">
            <ChevronLeft className="w-4 h-4" /> Campaigns
          </Button>
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold text-white">New Campaign</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure your outreach campaign</p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-xs font-medium ${i === step ? "text-sky-400" : i < step ? "text-emerald-400" : "text-gray-600"}`}>
              {i < step ? <CheckCircle2 className="w-3.5 h-3.5" /> : (
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] border ${i === step ? "border-sky-500 text-sky-400" : "border-gray-700 text-gray-600"}`}>
                  {i + 1}
                </span>
              )}
              {s}
            </div>
            {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-gray-700" />}
          </div>
        ))}
      </div>

      {/* ── STEP 0: Name + Prospect Selection ── */}
      {step === 0 && (
        <div className="space-y-4">
          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="p-4 space-y-3">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Campaign name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Q2 CARS+ Outreach — UK & Ireland"
                    className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Vertical</label>
                  <Select value={verticalPack} onValueChange={(v) => { setVerticalPack(v ?? verticalPack); loadProspects(v ?? verticalPack) }}>
                    <SelectTrigger className="bg-gray-800 border-gray-700 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-900 border-gray-700">
                      {(packs?.vertical ?? ["car_rental"]).map((v) => (
                        <SelectItem key={v} value={v}>{v.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Regional pack</label>
                  <Select value={regionalPack} onValueChange={(v) => setRegionalPack(v ?? regionalPack)}>
                    <SelectTrigger className="bg-gray-800 border-gray-700 text-sm">
                      <Globe className="w-3.5 h-3.5 mr-2 text-gray-500" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-900 border-gray-700">
                      {(packs?.regional ?? Object.keys(REGION_META)).map((r) => {
                        const meta = REGION_META[r] ?? { flag: "🌍", label: r }
                        return <SelectItem key={r} value={r}>{meta.flag} {meta.label}</SelectItem>
                      })}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Vendor + Product cascade — only shown for layered verticals (e.g. car_rental). */}
              {verticalIsLayered && (
                <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-800">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1.5">Vendor (company)</label>
                    <Select
                      value={vendorPack || ""}
                      onValueChange={(v) => setVendorPack(v ?? "")}
                      disabled={vendorsForVertical.length === 0}
                    >
                      <SelectTrigger className="bg-gray-800 border-gray-700 text-sm">
                        <SelectValue placeholder="Select a vendor" />
                      </SelectTrigger>
                      <SelectContent className="bg-gray-900 border-gray-700">
                        {vendorsForVertical.map((v) => (
                          <SelectItem key={v.pack_id} value={v.pack_id}>
                            {v.display_name || v.company_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1.5">Product</label>
                    <Select
                      value={productPack || ""}
                      onValueChange={(v) => setProductPack(v ?? "")}
                      disabled={productsForVendor.length === 0}
                    >
                      <SelectTrigger className="bg-gray-800 border-gray-700 text-sm">
                        <SelectValue placeholder="Select a product" />
                      </SelectTrigger>
                      <SelectContent className="bg-gray-900 border-gray-700">
                        {productsForVendor.map((p) => (
                          <SelectItem key={p.pack_id} value={p.pack_id}>
                            {p.display_name || p.product_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Prospect Selector */}
          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm text-gray-300 flex items-center gap-2">
                  <Users className="w-4 h-4 text-sky-400" />
                  Select Prospects
                </CardTitle>
                <div className="flex items-center gap-2">
                  {selected.size > 0 && (
                    <Badge className="bg-sky-900/40 text-sky-400 border-sky-800 border text-xs">
                      {selected.size} selected
                    </Badge>
                  )}
                  <button
                    onClick={() => setSelected(new Set())}
                    className="text-[10px] text-gray-600 hover:text-gray-400"
                  >
                    Clear all
                  </button>
                </div>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap gap-2 mt-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500" />
                  <input
                    type="text"
                    placeholder="Search..."
                    value={filterSearch}
                    onChange={(e) => setFilterSearch(e.target.value)}
                    className="pl-7 pr-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500 w-44"
                  />
                </div>

                <Select value={filterTier} onValueChange={(v) => setFilterTier(v ?? "all")}>
                  <SelectTrigger className="h-8 text-xs bg-gray-800 border-gray-700 w-32">
                    <SelectValue placeholder="ICP tier" />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-900 border-gray-700">
                    <SelectItem value="all">All tiers</SelectItem>
                    <SelectItem value="hot">Hot (75%+)</SelectItem>
                    <SelectItem value="warm">Warm (55–74%)</SelectItem>
                    <SelectItem value="cold">Cold (35–54%)</SelectItem>
                    <SelectItem value="out">Out (&lt;35%)</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={filterCountry} onValueChange={(v) => setFilterCountry(v ?? "all")}>
                  <SelectTrigger className="h-8 text-xs bg-gray-800 border-gray-700 w-28">
                    <SelectValue placeholder="Region" />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-900 border-gray-700">
                    <SelectItem value="all">All regions</SelectItem>
                    {countries.map((c) => (
                      <SelectItem key={c} value={c}>{COUNTRY_NAMES[c] ?? c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={filterOwnership} onValueChange={(v) => setFilterOwnership(v ?? "all")}>
                  <SelectTrigger className="h-8 text-xs bg-gray-800 border-gray-700 w-32">
                    <SelectValue placeholder="Ownership" />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-900 border-gray-700">
                    <SelectItem value="all">All ownership</SelectItem>
                    <SelectItem value="family">Family</SelectItem>
                    <SelectItem value="corporate">Corporate</SelectItem>
                    <SelectItem value="club">Club</SelectItem>
                  </SelectContent>
                </Select>

                {(filterSearch || filterCountry !== "all" || filterOwnership !== "all" || filterTier !== "all") && (
                  <button
                    onClick={() => { setFilterSearch(""); setFilterCountry("all"); setFilterOwnership("all"); setFilterTier("all") }}
                    className="text-[10px] text-gray-500 hover:text-gray-300 px-2 border border-gray-700 rounded-md"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </CardHeader>

            <CardContent className="p-0">
              {/* Table header */}
              <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-700 bg-gray-800/60">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  ref={(el) => { if (el) el.indeterminate = !allFilteredSelected && someFilteredSelected }}
                  onChange={toggleAll}
                  className="w-3.5 h-3.5 accent-sky-500 rounded shrink-0"
                />
                {(() => {
                  // Read column labels from the active pack's terminology so adding
                  // a new vertical = author its pack JSON, not edit this file.
                  const pack = verticals.find((v) => v.pack_id === verticalPack)
                  const term = pack?.industry_context?.terminology
                  const nameLabel = term?.entity_label_singular
                    ? term.entity_label_singular[0].toUpperCase() + term.entity_label_singular.slice(1)
                    : "Operator"
                  const sizeLabel = term?.size_field_short ?? "Size"
                  return (
                    <>
                      <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider flex-1">
                        {nameLabel}
                        <span className="ml-1.5 text-[10px] font-normal text-gray-500 normal-case tracking-normal">
                          {filtered.length !== allProspects.length ? `${filtered.length} filtered` : `${allProspects.length} total`}
                        </span>
                      </span>
                      <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider w-20 text-center">Region</span>
                      <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider w-14 text-center">
                        {sizeLabel}
                      </span>
                    </>
                  )
                })()}
                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider w-16 text-center">Online</span>
                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider w-20 text-center">Ownership</span>
                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider w-16 text-right">ICP Score</span>
              </div>

              {/* Scrollable prospect list */}
              <div className="overflow-y-auto max-h-72">
                {prospectsLoading ? (
                  <div className="px-4 py-6 text-xs text-gray-500 text-center">Loading prospects...</div>
                ) : filtered.length === 0 ? (
                  <div className="px-4 py-6 text-xs text-gray-500 text-center">No prospects match the current filters.</div>
                ) : (
                  filtered.map((p) => {
                    const icp = icpTier(p.icp_score)
                    const isSelected = selected.has(p.id)
                    return (
                      <label
                        key={p.id}
                        className={cn(
                          "flex items-center gap-3 px-4 py-2.5 border-b border-gray-800/50 cursor-pointer transition-colors",
                          isSelected ? "bg-sky-950/20" : "hover:bg-gray-800/30"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(p.id)}
                          className="w-3.5 h-3.5 accent-sky-500 rounded shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm text-white font-medium truncate">{p.business_name}</span>
                            {p.research_profile && (
                              <span title="Research complete"><Brain className="w-3 h-3 text-violet-400 shrink-0" /></span>
                            )}
                          </div>
                          <div className="text-[10px] text-gray-500 truncate">{p.contact_name} · {p.city}</div>
                        </div>
                        <span className="w-20 text-center text-xs text-gray-400 shrink-0">
                          {COUNTRY_NAMES[p.country_code] ?? p.country_code}
                        </span>
                        <span className="w-14 text-center text-xs text-gray-400 shrink-0">
                          {p.capacity_count ?? "—"}
                        </span>
                        <span className="w-16 text-center shrink-0" title={p.has_online_booking ? "Online booking enabled" : "No online booking"}>
                          {p.has_online_booking
                            ? <Wifi className="w-3 h-3 text-emerald-400 mx-auto" />
                            : <WifiOff className="w-3 h-3 text-gray-600 mx-auto" />
                          }
                        </span>
                        <span className="w-20 text-center shrink-0">
                          <Badge variant="outline" className="text-[10px] border-gray-700 text-gray-400 capitalize px-1.5 py-0">
                            {p.ownership_type}
                          </Badge>
                        </span>
                        <span className={cn("w-16 text-right text-xs font-medium shrink-0", icp.color)}>
                          {icp.label}
                        </span>
                      </label>
                    )
                  })
                )}
              </div>

              {/* Footer summary */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-800 bg-gray-800/20">
                <span className="text-xs text-gray-500">
                  {selected.size === 0
                    ? "No prospects selected"
                    : `${selected.size} of ${allProspects.length} prospects selected`}
                </span>
                <div className="flex gap-2 text-[10px]">
                  <button
                    onClick={() => setSelected(new Set(allProspects.filter((p) => (p.icp_score ?? 0) >= 0.75).map((p) => p.id)))}
                    className="text-emerald-400 hover:underline"
                  >
                    Hot only
                  </button>
                  <span className="text-gray-700">·</span>
                  <button
                    onClick={() => setSelected(new Set(allProspects.filter((p) => (p.icp_score ?? 0) >= 0.55).map((p) => p.id)))}
                    className="text-sky-400 hover:underline"
                  >
                    Warm + Hot
                  </button>
                  <span className="text-gray-700">·</span>
                  <button
                    onClick={() => setSelected(new Set(allProspects.map((p) => p.id)))}
                    className="text-gray-400 hover:underline"
                  >
                    Select all
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          {!name.trim() && (
            <p className="text-xs text-amber-500/80 text-center -mb-1">Enter a campaign name to continue</p>
          )}
          {verticalIsLayered && !(vendorPack && productPack) && (
            <p className="text-xs text-amber-500/80 text-center -mb-1">Pick a vendor and product to continue</p>
          )}
          <Button
            className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!name.trim() || selected.size === 0 || (verticalIsLayered && !(vendorPack && productPack))}
            onClick={() => setStep(1)}
          >
            Continue with {selected.size} prospect{selected.size !== 1 ? "s" : ""} <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      )}

      {/* ── STEP 1: Sequence Config ── */}
      {step === 1 && (
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader><CardTitle className="text-sm text-gray-300">Sequence Configuration</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div>
              <label className="block text-xs text-gray-500 mb-2">Number of touches</label>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setTouches(n)}
                    className={cn(
                      "flex-1 py-2 rounded-lg border text-sm font-medium transition-all",
                      touches === n
                        ? "bg-sky-600/20 border-sky-600 text-sky-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300"
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-gray-600 mt-1.5">
                <span>Single email</span><span>Full sequence</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-2">Days between touches</label>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <button
                    key={n}
                    onClick={() => setDelayDays(n)}
                    className={cn(
                      "flex-1 py-2 rounded-lg border text-sm font-medium transition-all",
                      delayDays === n
                        ? "bg-sky-600/20 border-sky-600 text-sky-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300"
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-gray-600 mt-1.5">
                <span>1 day apart</span><span>7 days apart</span>
              </div>
            </div>

            <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
              <div className="text-xs text-gray-500 font-medium">Sequence preview ({REGION_META[regionalPack]?.flag} {regionalPack})</div>
              {Array.from({ length: touches }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <div className="w-5 h-5 rounded-full bg-sky-900 text-sky-400 flex items-center justify-center text-[10px] font-medium shrink-0">{i + 1}</div>
                  <div className="flex-1 text-gray-300">
                    Touch {i + 1} — Day {i * delayDays}
                    {i === 0 && " (send now)"}
                    {i === touches - 1 && touches > 1 && " (final ask)"}
                  </div>
                </div>
              ))}
              <div className="text-[10px] text-gray-600 pt-1">
                Holiday-aware scheduling via Nager.Date for {REGION_META[regionalPack]?.label ?? regionalPack}
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(0)} className="border-gray-700 text-gray-400">
                <ChevronLeft className="w-4 h-4 mr-1" /> Back
              </Button>
              <Button className="flex-1 bg-sky-600 hover:bg-sky-500" onClick={() => setStep(2)}>
                Review <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── STEP 2: Review & Launch ── */}
      {step === 2 && (
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader><CardTitle className="text-sm text-gray-300">Review & Launch</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {[
              { label: "Campaign name", value: name },
              { label: "Vertical",      value: verticalPack.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) },
              ...(verticalIsLayered ? [
                { label: "Vendor",  value: vendors.find((v) => v.pack_id === vendorPack)?.company_name ?? vendorPack ?? "—" },
                { label: "Product", value: products.find((p) => p.pack_id === productPack)?.product_name ?? productPack ?? "—" },
              ] : []),
              { label: "Regional pack", value: `${REGION_META[regionalPack]?.flag ?? "🌍"} ${REGION_META[regionalPack]?.label ?? regionalPack}` },
              { label: "Sequence",      value: `${touches} touches, ${delayDays} days apart` },
              { label: "Enrolled",      value: `${selected.size} prospects (manually selected)` },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between text-sm border-b border-gray-800 pb-3">
                <span className="text-gray-500">{label}</span>
                <span className="text-white font-medium">{value}</span>
              </div>
            ))}

            <div className="bg-sky-950/30 border border-sky-900/50 rounded-lg p-3 text-xs text-sky-300">
              After creating, run the AI pipeline to generate personalised email drafts for all enrolled prospects. All emails require approval before being marked as sent.
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(1)} className="border-gray-700 text-gray-400">
                <ChevronLeft className="w-4 h-4 mr-1" /> Back
              </Button>
              <Button className="flex-1 bg-emerald-600 hover:bg-emerald-500" onClick={create} disabled={creating}>
                {creating ? "Creating..." : `Create Campaign with ${selected.size} Prospects`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
