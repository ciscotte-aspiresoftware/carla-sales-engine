/**
 * Shared country list for prospect discovery and campaign filters.
 * Ordered by marina market size / relevance.
 */

export interface Country {
  code: string
  label: string
  flag: string
}

export const COUNTRIES: Country[] = [
  // North America
  { code: "US", flag: "🇺🇸", label: "United States" },
  { code: "CA", flag: "🇨🇦", label: "Canada" },
  { code: "MX", flag: "🇲🇽", label: "Mexico" },

  // Oceania
  { code: "AU", flag: "🇦🇺", label: "Australia" },
  { code: "NZ", flag: "🇳🇿", label: "New Zealand" },

  // Northern Europe
  { code: "GB", flag: "🇬🇧", label: "United Kingdom" },
  { code: "IE", flag: "🇮🇪", label: "Ireland" },
  { code: "NL", flag: "🇳🇱", label: "Netherlands" },
  { code: "DE", flag: "🇩🇪", label: "Germany" },
  { code: "DK", flag: "🇩🇰", label: "Denmark" },
  { code: "SE", flag: "🇸🇪", label: "Sweden" },
  { code: "NO", flag: "🇳🇴", label: "Norway" },
  { code: "FI", flag: "🇫🇮", label: "Finland" },

  // Western Europe
  { code: "FR", flag: "🇫🇷", label: "France" },
  { code: "BE", flag: "🇧🇪", label: "Belgium" },
  { code: "CH", flag: "🇨🇭", label: "Switzerland" },
  { code: "AT", flag: "🇦🇹", label: "Austria" },
  { code: "PT", flag: "🇵🇹", label: "Portugal" },
  { code: "ES", flag: "🇪🇸", label: "Spain" },
  { code: "MC", flag: "🇲🇨", label: "Monaco" },

  // Mediterranean
  { code: "IT", flag: "🇮🇹", label: "Italy" },
  { code: "HR", flag: "🇭🇷", label: "Croatia" },
  { code: "GR", flag: "🇬🇷", label: "Greece" },
  { code: "MT", flag: "🇲🇹", label: "Malta" },
  { code: "CY", flag: "🇨🇾", label: "Cyprus" },
  { code: "TR", flag: "🇹🇷", label: "Turkey" },
  { code: "SI", flag: "🇸🇮", label: "Slovenia" },
  { code: "ME", flag: "🇲🇪", label: "Montenegro" },

  // Middle East & Asia Pacific
  { code: "AE", flag: "🇦🇪", label: "UAE" },
  { code: "QA", flag: "🇶🇦", label: "Qatar" },
  { code: "BH", flag: "🇧🇭", label: "Bahrain" },
  { code: "SG", flag: "🇸🇬", label: "Singapore" },
  { code: "HK", flag: "🇭🇰", label: "Hong Kong" },
  { code: "JP", flag: "🇯🇵", label: "Japan" },
  { code: "TH", flag: "🇹🇭", label: "Thailand" },
  { code: "MY", flag: "🇲🇾", label: "Malaysia" },
  { code: "ID", flag: "🇮🇩", label: "Indonesia" },
  { code: "PH", flag: "🇵🇭", label: "Philippines" },

  // Caribbean & Central America
  { code: "BS", flag: "🇧🇸", label: "Bahamas" },
  { code: "BB", flag: "🇧🇧", label: "Barbados" },
  { code: "AG", flag: "🇦🇬", label: "Antigua & Barbuda" },
  { code: "BVI", flag: "🇻🇬", label: "British Virgin Islands" },
  { code: "PA", flag: "🇵🇦", label: "Panama" },

  // South America
  { code: "BR", flag: "🇧🇷", label: "Brazil" },
  { code: "AR", flag: "🇦🇷", label: "Argentina" },
  { code: "CL", flag: "🇨🇱", label: "Chile" },

  // Africa
  { code: "ZA", flag: "🇿🇦", label: "South Africa" },
  { code: "MA", flag: "🇲🇦", label: "Morocco" },
]

/** Flat record for quick lookup by code: { US: "🇺🇸 US", ... } */
export const COUNTRY_NAMES: Record<string, string> = Object.fromEntries(
  COUNTRIES.map((c) => [c.code, `${c.flag} ${c.code}`])
)

/** Full label lookup: { US: "🇺🇸 United States", ... } */
export const COUNTRY_LABELS: Record<string, string> = Object.fromEntries(
  COUNTRIES.map((c) => [c.code, `${c.flag} ${c.label}`])
)
