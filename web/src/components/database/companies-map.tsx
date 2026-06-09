// 2D Leaflet map for the Database page - plots every company that has
// a stored lat/lng (captured from Scrapingdog Maps' gps_coordinates).
// Color-coded by classification.is_match so qualified leads pop green,
// rejected ones red, and stub/error records sit dimly in gray. Click a
// marker → fires onSelect so the parent can open a detail drawer.
//
// Map auto-fits to the bounds of all loaded companies the first time
// they appear, then stops auto-fitting (so user pan/zoom isn't undone
// when new sweep results arrive). CartoDB Positron / Dark Matter for
// theme-aware muted basemap - same setup as the Coverage map.

import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { LatLngBoundsExpression } from 'leaflet'
import type { CompanyRecord } from '@/lib/api'

// CartoDB Positron - same desaturated tiles the Coverage map uses.
// Stays light-themed in both light and dark UI modes since the dark-tile
// variant made markers hard to read against the already-dark UI chrome.
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'

interface Props {
  companies: CompanyRecord[]
  selectedId?: string | null
  onSelect?: (company: CompanyRecord) => void
}

export default function CompaniesMap({ companies, selectedId, onSelect }: Props) {
  // Only companies that have a stored coordinate can render; the rest
  // (paste-classified, pre-feature, etc.) just don't appear on the map.
  const placed = useMemo(
    () => companies.filter((c) => c.location && Number.isFinite(c.location.lat) && Number.isFinite(c.location.lng)),
    [companies],
  )

  const initialBounds = useMemo<LatLngBoundsExpression | null>(() => {
    if (placed.length === 0) return null
    let minLat = +Infinity, maxLat = -Infinity, minLng = +Infinity, maxLng = -Infinity
    for (const c of placed) {
      const { lat, lng } = c.location!
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
    return [[minLat, minLng], [maxLat, maxLng]]
  }, [placed])

  // No coordinates at all yet - friendly placeholder. Don't mount the
  // MapContainer; Leaflet errors on bounds with zero markers and the
  // user has nothing to look at anyway.
  if (placed.length === 0) {
    return (
      <div className="h-full grid place-items-center text-center px-6 text-muted-foreground">
        <div>
          <p className="text-sm mb-1">No companies have a location yet.</p>
          <p className="text-xs leading-relaxed max-w-sm">
            New sweeps capture lat/lng from Google Maps automatically. Pre-existing
            paste-classified rows won't appear here - only companies found via the
            Coverage sweep show up on this map.
          </p>
        </div>
      </div>
    )
  }

  return (
    <MapContainer
      bounds={initialBounds || undefined}
      boundsOptions={{ padding: [40, 40] }}
      scrollWheelZoom
      className="w-full h-full rounded-2xl"
      zoomControl={false}
    >
      <TileLayer
        attribution={TILE_ATTRIBUTION}
        url={TILE_URL}
      />
      <FitBoundsOnce bounds={initialBounds} />
      {placed.map((c) => (
        <CompanyMarker
          key={c.id}
          company={c}
          isSelected={selectedId === c.id}
          onClick={() => onSelect?.(c)}
        />
      ))}
    </MapContainer>
  )
}

// Fits the map to the initial bounds ONCE on mount, then doesn't fight
// user pan/zoom. Without this, every render that recomputes bounds would
// re-fit the map and undo the user's navigation.
function FitBoundsOnce({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap()
  const [didFit, setDidFit] = useState(false)
  useEffect(() => {
    if (!bounds || didFit) return
    map.fitBounds(bounds, { padding: [40, 40] })
    setDidFit(true)
  }, [map, bounds, didFit])
  return null
}

function CompanyMarker({
  company,
  isSelected,
  onClick,
}: {
  company: CompanyRecord
  isSelected: boolean
  onClick: () => void
}) {
  // Classification has different shapes depending on source (paste-classify
  // uses isCarRental/confidence; sweep pipeline uses is_match/title/address).
  // Cast to any so we can read whichever fields exist on this record.
  const cls = (company.classification || {}) as any
  // Color triad - green qualified, red rejected, gray for stubs (null
  // is_match: no website, scrape error, etc.)
  let stroke = '#64748b'
  let fill = '#cbd5e1'
  if (cls.is_match === true) { stroke = '#15803d'; fill = '#22c55e' }
  else if (cls.is_match === false) { stroke = '#b91c1c'; fill = '#ef4444' }
  const radius = isSelected ? 11 : 7
  const weight = isSelected ? 3.5 : 2

  return (
    <CircleMarker
      center={[company.location!.lat, company.location!.lng]}
      radius={radius}
      pathOptions={{
        color: stroke,
        fillColor: fill,
        fillOpacity: 0.85,
        weight,
        opacity: 1,
      }}
      eventHandlers={{ click: onClick }}
    >
      <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
        <div className="text-xs">
          <div className="font-semibold">{cls.title || company.domain || 'Unknown'}</div>
          <div className="opacity-80">
            {cls.is_match === true ? 'Qualified' : cls.is_match === false ? 'Rejected' : 'Stub'}
            {cls.address ? ` · ${cls.address}` : ''}
          </div>
        </div>
      </Tooltip>
    </CircleMarker>
  )
}
