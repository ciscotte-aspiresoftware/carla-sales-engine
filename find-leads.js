// Bluebird sourcing 

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'

const API_KEY = process.env.SCRAPINGDOG_API_KEY
const MAX_RUN = parseInt(process.env.MAX_RUN || '6', 10)

if (!API_KEY) {
  console.error('Missing SCRAPINGDOG_API_KEY. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const QUERY = 'car rental'


const TARGET_TYPES = new Set([
  
  'Car rental agency',
  'Car rental service',
  'Van rental agency',
  'Truck rental agency',
  'Vehicle rental agency',
  'Vehicle rental',
  
  'Autoverhuurbedrijf',
  'Autoverhuur',
 
  'Autovermietung',
  'Autovermietagentur',
  'Mietwagenfirma',
 
  'Agence de location de voitures',
  'Société de location de voitures',
  
  'Agencia de alquiler de coches',
  'Empresa de alquiler de coches',
 
  'Autonoleggio',
  
  'Locadora de veículos',
  'Empresa de aluguer de automóveis',
])


const CITIES = [
  { city: 'New York',    country: 'US', domain: 'google.com',    language: 'en', ll: '@40.7128,-74.0060,12z' },
  { city: 'London',      country: 'UK', domain: 'google.co.uk',  language: 'en', ll: '@51.5074,-0.1278,12z' },
  //{ city: 'Amsterdam',   country: 'NL', domain: 'google.nl',     language: 'nl', ll: '@52.3676,4.9041,12z' },
  { city: 'Los Angeles', country: 'US', domain: 'google.com',    language: 'en', ll: '@34.0522,-118.2437,12z' },
  //{ city: 'Miami',       country: 'US', domain: 'google.com',    language: 'en', ll: '@25.7617,-80.1918,12z' },
  { city: 'Toronto',     country: 'CA', domain: 'google.ca',     language: 'en', ll: '@43.6532,-79.3832,12z' },
  //{ city: 'Paris',       country: 'FR', domain: 'google.fr',     language: 'fr', ll: '@48.8566,2.3522,12z' },
  //{ city: 'Berlin',      country: 'DE', domain: 'google.de',     language: 'de', ll: '@52.5200,13.4050,12z' },
  //{ city: 'Madrid',      country: 'ES', domain: 'google.es',     language: 'es', ll: '@40.4168,-3.7038,12z' },
  //{ city: 'Sydney',      country: 'AU', domain: 'google.com.au', language: 'en', ll: '@-33.8688,151.2093,12z' },
]


const PAGE_OFFSETS = [0, 20]


const CHAIN_DOMAIN_BLOCKLIST = new Set([

  'hertz.com', 'hertz.co.uk', 'hertz.de', 'hertz.fr', 'hertz.nl', 'hertz.es', 'hertz.it', 'hertz.ca', 'hertz.com.au',
  
  'enterprise.com', 'enterprise.co.uk', 'enterprise.de', 'enterprise.fr', 'enterprise.nl', 'enterprise.es', 'enterprise.it', 'enterprise.ca',
 
  'avis.com', 'avis.co.uk', 'avis.de', 'avis.fr', 'avis.nl', 'avis.es', 'avis.it', 'avis.ca', 'avis.com.au',

  'budget.com', 'budget.co.uk', 'budget.de', 'budget.fr', 'budget.nl', 'budget.es', 'budget.com.au',

  'alamo.com', 'alamo.co.uk', 'national.com', 'nationalcar.com', 'nationalcar.co.uk',

  'sixt.com', 'sixt.co.uk', 'sixt.de', 'sixt.fr', 'sixt.nl', 'sixt.es',
 
  'europcar.com', 'europcar.co.uk', 'europcar.de', 'europcar.fr', 'europcar.nl', 'europcar.es', 'europcar.it',

  'dollar.com', 'thrifty.com', 'foxrentacar.com', 'aceriacar.com', 'acerentacar.com',
  'paylesscar.com', 'easirent.com', 'goldcar.es', 'firefly.com',
  'drivalia.com', 'drivalia.co.uk',
  'greenmotion.com',

])

function extractDomain(url) {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function isChain(domain) {
  if (!domain) return false
  return CHAIN_DOMAIN_BLOCKLIST.has(domain)
}

async function fetchMapsPage({ city, country, domain, language, ll, pageOffset }) {
  const url = new URL('https://api.scrapingdog.com/google_maps')
  url.searchParams.set('api_key', API_KEY)
  url.searchParams.set('query', QUERY)
  url.searchParams.set('ll', ll)
  url.searchParams.set('page', String(pageOffset))
  url.searchParams.set('domain', domain)
  url.searchParams.set('language', language)
  url.searchParams.set('country', country.toLowerCase())

  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ScrapingDog ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const results = data.search_results || []

  return results.map((r) => {
    const types = Array.isArray(r.types) ? r.types : (r.type ? [r.type] : [])
    return {
      name: r.title || '',
      place_id: r.place_id || '',
      data_id: r.data_id || '',
      website: r.website || '',
      domain: extractDomain(r.website),
      phone: r.phone || '',
      address: r.address || '',
      city,
      country,
      latitude: r.gps_coordinates?.latitude ?? '',
      longitude: r.gps_coordinates?.longitude ?? '',
      rating: r.rating ?? '',
      reviews: r.reviews ?? '',
      price: r.price || '',
      primary_type: r.type || '',
      all_types: types.join(' | '),
      description: r.description || '',
      is_target_type: types.some((t) => TARGET_TYPES.has(t)),
      has_website: !!r.website,
    }
  })
}

function csvEscape(value) {
  const s = value == null ? '' : String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function writeCsv(rows, outPath) {
  const headers = [
    'name', 'is_target_type', 'has_website', 'domain', 'website', 'phone',
    'address', 'city', 'country', 'rating', 'reviews', 'price',
    'primary_type', 'all_types', 'description',
    'latitude', 'longitude', 'place_id', 'data_id',
  ]
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','))
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
}

function dedupe(rows) {
  const byKey = new Map()
  for (const row of rows) {
    // Prefer place_id (most stable), fall back to domain, then to name+city.
    const key = row.place_id || row.domain || `${row.name}::${row.city}`.toLowerCase()
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, row)
  }
  return [...byKey.values()]
}

async function main() {
  const outDir = path.join(process.cwd(), 'output')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

  const allRows = []
  let requestCount = 0
  let chainsFiltered = 0

  const totalPlanned = CITIES.length * PAGE_OFFSETS.length
  console.log(`Searching "${QUERY}" across ${CITIES.length} cities × ${PAGE_OFFSETS.length} pages = ${totalPlanned} requests planned (MAX_RUN=${MAX_RUN}).`)
  console.log(`Cost: 5 credits/request → up to ${Math.min(totalPlanned, MAX_RUN) * 5} credits this run.\n`)

  outer: for (const city of CITIES) {
    for (const pageOffset of PAGE_OFFSETS) {
      if (requestCount >= MAX_RUN) {
        console.log(`Hit MAX_RUN (${MAX_RUN}). Stopping.`)
        break outer
      }
      requestCount++
      try {
        const rows = await fetchMapsPage({ ...city, pageOffset })
        const kept = rows.filter((r) => {
          if (isChain(r.domain)) { chainsFiltered++; return false }
          return r.name
        })
        const targetCount = kept.filter((r) => r.is_target_type).length
        allRows.push(...kept)
        console.log(
          `  ${city.city.padEnd(12)} p${String(pageOffset).padStart(3)}: ${rows.length} raw, ${kept.length} kept (${targetCount} target-type) — running total: ${allRows.length}`
        )
      } catch (err) {
        console.error(`  ${city.city} p${pageOffset}: FAILED — ${err.message}`)
      }
      // Small pause between requests.
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  const deduped = dedupe(allRows)
  const targetMatches = deduped.filter((r) => r.is_target_type).length
  const withWebsite = deduped.filter((r) => r.has_website).length

  const stamp = new Date().toISOString().slice(0, 10)
  const outPath = path.join(outDir, `leads-${stamp}.csv`)
  writeCsv(deduped, outPath)

  console.log(`\nDone.`)
  console.log(`  Requests sent:     ${requestCount}`)
  console.log(`  Credits consumed:  ${requestCount * 5}`)
  console.log(`  Chains filtered:   ${chainsFiltered}`)
  console.log(`  Raw rows:          ${allRows.length}`)
  console.log(`  Deduped rows:      ${deduped.length}`)
  console.log(`  Target-type:       ${targetMatches} (filter on is_target_type=true)`)
  console.log(`  With website:      ${withWebsite}`)
  console.log(`  Output:            ${outPath}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
