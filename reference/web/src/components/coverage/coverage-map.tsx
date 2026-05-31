// 2D Leaflet map for the per-cell sweep dashboard.
//
// Used post-seed when there are real grid cells to render. Renders a
// proper OpenStreetMap basemap so the user can see which boroughs / streets
// each cell covers - the globe view can't show that level of detail.
//
// Coverage cells render as Leaflet CircleMarkers, color-coded per state,
// with a CSS opacity pulse on `scanning`. Clicks open the side drawer
// (same handler as the globe). City/country scope changes drive a flyTo
// (single point) or flyToBounds (country bbox) animation.

import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, CircleMarker, Circle, useMap, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { LatLngBoundsExpression } from 'leaflet'
import type { CoverageCell } from './coverage-globe'

// CartoDB Positron tiles - desaturated gray-on-white, designed for data
// overlays so colored markers dominate. We previously themed-swapped to
// Dark Matter in dark mode, but the result fought the dark UI rather
// than complementing it: cell dots got lost against the dark gray, and
// the Coverage globe + map looked inconsistent across pages. Sticking to
// Positron in both themes keeps the geo content reliably legible. Free
// for non-commercial use; attribution rendered bottom-right by Leaflet.
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'

// Preview cells = candidates that haven't been persisted yet. Rendered
// with a distinct dashed-outline halo + a solid coloured dot so the user
// can see exactly where each cell will land. Color scheme matches the
// ICP form's tier toggle pills (urban=sky, suburban=violet, rural=green,
// airport=amber, sparse=dark-green) so the map and form stay in sync.
export interface PreviewCell {
  lat: number
  lng: number
  tier?: number
  parentCity?: string | null
  placeSource?: string  // 'populated' | 'airport' | 'sparse' for the country-fill preview
  placeTier?: string    // 'urban' | 'suburban' | 'rural' for populated places
  radiusKm?: number     // search radius - drives the translucent halo
}

interface Props {
  cells: CoverageCell[]
  /** City/free-point center to recenter the map on. */
  centerLat: number
  centerLng: number
  /** Optional country bbox - when present, the map fits to these bounds
      instead of using `centerLat/Lng`. Used when scope='country'. */
  bounds?: LatLngBoundsExpression | null
  onCellClick?: (cell: CoverageCell) => void
  selectedCellId?: string | null
  /** Pending preview cells - rendered with a distinct outlined style
      below the real cells. Cleared once the user confirms the seed. */
  previewCells?: PreviewCell[]
  /** Fired on every zoom/pan-end with the new zoom level + the current
      map center. The page uses this to (a) flip back to the globe view
      when the user zooms out past a continent-scale threshold, and (b)
      hand the globe an initial center matching wherever the user was
      looking on the map. */
  onZoomChange?: (zoom: number, center: { lat: number; lng: number }) => void
}

export default function CoverageMap({
  cells,
  centerLat,
  centerLng,
  bounds,
  onCellClick,
  selectedCellId,
  previewCells,
  onZoomChange,
}: Props) {
  // Initial center/zoom only - flyTo/flyToBounds handle subsequent moves.
  // If we passed a bounds initially MapContainer would still need a center,
  // so we always provide one and let FlyTo override after mount.
  const initialCenter: [number, number] =
    Number.isFinite(centerLat) && Number.isFinite(centerLng)
      ? [centerLat, centerLng]
      : [51.5074, -0.1278]

  return (
    <MapContainer
      center={initialCenter}
      zoom={11}
      scrollWheelZoom
      className="w-full h-full rounded-2xl"
      // Disable Leaflet's default zoom buttons - we use scroll/pinch only,
      // and the +/- buttons would clash with the glass card frame.
      zoomControl={false}
    >
      <TileLayer
        attribution={TILE_ATTRIBUTION}
        url={TILE_URL}
      />
      <FlyTo lat={centerLat} lng={centerLng} bounds={bounds} />
      <ZoomReporter onZoomChange={onZoomChange} />
      {/* Coverage halos render BEFORE markers so the dots sit on top of
          their own circle. Always rendered for preview cells (the user
          needs to see the proposed coverage); only for the selected real
          cell otherwise (avoid the cluttered "all halos at once" look). */}
      <CoverageHalos
        cells={cells}
        selectedCellId={selectedCellId}
        previewCells={previewCells}
      />
      <CellMarkers cells={cells} onCellClick={onCellClick} selectedCellId={selectedCellId} />
      <PreviewMarkers preview={previewCells} />
    </MapContainer>
  )
}

// Reports the current zoom level + center to the parent on every zoom
// or pan settle. Used to (a) detect "zoomed out far enough - swap back
// to globe view" and (b) record the user's current map position so the
// globe can re-open at the same place if they pan-then-zoom-out.
function ZoomReporter({
  onZoomChange,
}: {
  onZoomChange?: (z: number, center: { lat: number; lng: number }) => void
}) {
  const map = useMap()
  useEffect(() => {
    if (!onZoomChange) return
    const handler = () => {
      const c = map.getCenter()
      onZoomChange(map.getZoom(), { lat: c.lat, lng: c.lng })
    }
    map.on('zoomend', handler)
    map.on('moveend', handler) // pans should also update the recorded center
    handler() // initial fire so the parent has a baseline
    return () => {
      map.off('zoomend', handler)
      map.off('moveend', handler)
    }
  }, [map, onZoomChange])
  return null
}

// Imperatively flies the map to the new center or bounds whenever the
// props change. Lives as a child component so it can call `useMap()`.
function FlyTo({
  lat,
  lng,
  bounds,
}: {
  lat: number
  lng: number
  bounds?: LatLngBoundsExpression | null
}) {
  const map = useMap()
  useEffect(() => {
    if (bounds) {
      map.flyToBounds(bounds, { duration: 1.2, padding: [40, 40] })
    } else if (Number.isFinite(lat) && Number.isFinite(lng)) {
      map.flyTo([lat, lng], 11, { duration: 1.2 })
    }
    // bounds takes precedence; if it changes, re-fit. If only lat/lng
    // changed (city scope), animate to the new point.
  }, [lat, lng, bounds, map])
  return null
}

// Coverage halos - translucent circles around each cell representing
// the cell's actual Scrapingdog search radius. Helps the user understand
// "this rural cell catches a 28 km area, this urban one only 7 km" when
// reviewing the layout. Color matches the marker source so the halo
// reads as belonging to the dot inside it.
function CoverageHalos({
  cells,
  selectedCellId,
  previewCells,
}: {
  cells: CoverageCell[]
  selectedCellId?: string | null
  previewCells?: PreviewCell[]
}) {
  // Selected real cell only - showing every cell's radius simultaneously
  // would carpet the map in overlapping circles in dense areas.
  const selected = selectedCellId
    ? cells.find((c) => c.id === selectedCellId)
    : null

  return (
    <>
      {selected && (
        <Circle
          center={[selected.lat, selected.lng]}
          radius={(selected.radiusKm ?? defaultRadiusForTier(selected.tier)) * 1000}
          pathOptions={{
            color: '#0284c7',
            fillColor: '#38bdf8',
            fillOpacity: 0.10,
            weight: 1.5,
            opacity: 0.55,
            dashArray: '4 4',
          }}
        />
      )}
      {(previewCells || []).map((p, i) => {
        const km = p.radiusKm ?? defaultRadiusForSource(p.placeSource, p.tier)
        const stroke = strokeForCell(p)
        return (
          <Circle
            key={`halo-${i}-${p.lat.toFixed(4)}-${p.lng.toFixed(4)}`}
            center={[p.lat, p.lng]}
            radius={km * 1000}
            pathOptions={{
              color: stroke,
              fillColor: stroke,
              fillOpacity: 0.06,
              weight: 1,
              opacity: 0.4,
              dashArray: '3 4',
            }}
          />
        )
      })}
    </>
  )
}

// Reasonable defaults if a cell predates the radiusKm field.
function defaultRadiusForTier(tier?: number): number {
  return tier === 2 ? 14 : 5
}
function defaultRadiusForSource(source?: string, tier?: number): number {
  if (source === 'sparse') return 28
  if (source === 'airport') return 7
  if (tier === 2) return 14
  return 5
}
// Color a cell by its source + density tier. Matches the four ICP form
// toggle pills (sky/violet/emerald/amber) so a quick glance at the map
// tells you which tier produced each cell. Sparse-rural backstop gets a
// dark green that reads distinctly against rural-populated's emerald.
function strokeForCell(p: { placeSource?: string; placeTier?: string }): string {
  if (p.placeSource === 'airport') return '#d97706'   // amber
  if (p.placeSource === 'sparse')  return '#166534'   // dark green
  if (p.placeTier === 'urban')     return '#0284c7'   // sky
  if (p.placeTier === 'suburban')  return '#7c3aed'   // violet
  if (p.placeTier === 'rural')     return '#16a34a'   // green
  return '#0284c7'
}
// Backwards-compat shim - older call sites use a string source only.
function strokeForSource(source?: string): string {
  return strokeForCell({ placeSource: source })
}

// Preview markers - outlined hollow circles styled to read as "about to
// be added" without competing with the real (persisted) cells. Source-
// coloured outline (sky for populated places, amber for airports, green
// for sparse rural backstop) so the user can sanity-check the mix.
function PreviewMarkers({ preview }: { preview?: PreviewCell[] }) {
  if (!preview || preview.length === 0) return null
  return (
    <>
      {preview.map((p, i) => {
        const stroke = strokeForCell(p)
        // Solid dot at each cell centre so users can SEE the seed at a
        // city centre. Previously fillOpacity was 0.05 (basically
        // invisible) - every preview looked like an empty circle ring,
        // exactly the "no seed at city centre" complaint from the field.
        const radius = p.tier === 2 ? 5 : 7
        return (
          <CircleMarker
            key={`prev-${i}-${p.lat.toFixed(4)}-${p.lng.toFixed(4)}`}
            center={[p.lat, p.lng]}
            radius={radius}
            pathOptions={{
              color: stroke,
              fillColor: stroke,
              fillOpacity: 0.85,
              weight: 2,
              opacity: 1,
              className: 'cm-cell cm-cell-preview',
            }}
          >
            <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
              <div className="text-xs">
                <div className="font-semibold">Preview</div>
                <div className="opacity-80">
                  {p.parentCity || (p.placeSource === 'airport' ? 'Airport' : p.placeSource === 'sparse' ? 'Rural backstop' : 'Cell')}
                  {p.tier === 2 ? ' · Tier 2' : ' · Tier 1'}
                </div>
              </div>
            </Tooltip>
          </CircleMarker>
        )
      })}
    </>
  )
}

function CellMarkers({
  cells,
  onCellClick,
  selectedCellId,
}: {
  cells: CoverageCell[]
  onCellClick?: (cell: CoverageCell) => void
  selectedCellId?: string | null
}) {
  // Style per state. Sized + saturated so they pop against the muted
  // CartoDB basemap. Strokes are saturated and fills are vivid.
  const markers = useMemo(() => {
    return cells.map((c) => {
      const tier = c.tier === 2 ? 2 : 1
      const isSelected = selectedCellId === c.id
      let color = '#0284c7'    // sky-600 stroke
      let fillColor = '#38bdf8' // sky-400 fill
      if (c.state === 'scanning') { color = '#b91c1c'; fillColor = '#ef4444' }   // red-700 / red-500
      else if (c.state === 'complete') { color = '#15803d'; fillColor = '#22c55e' } // green-700 / green-500
      else if (c.state === 'empty')    { color = '#64748b'; fillColor = '#cbd5e1' } // slate-500 / slate-300
      const baseRadius = tier === 2 ? 5 : 9
      const radius = isSelected ? baseRadius * 1.5 : baseRadius
      const weight = isSelected ? 3.5 : 2.25
      // Scanning cells get a className the CSS pulse-opacity keyframe
      // hooks into. Others get a stable class so we don't disrupt React's
      // reconciliation.
      const className = c.state === 'scanning' ? 'cm-cell cm-cell-pulse' : 'cm-cell'
      return { c, color, fillColor, radius, weight, className }
    })
  }, [cells, selectedCellId])

  return (
    <>
      {markers.map(({ c, color, fillColor, radius, weight, className }) => (
        <CircleMarker
          key={c.id}
          center={[c.lat, c.lng]}
          radius={radius}
          pathOptions={{
            color,
            fillColor,
            fillOpacity: 0.85,
            weight,
            opacity: 1,
            className,
          }}
          eventHandlers={{
            click: () => onCellClick?.(c),
          }}
        >
          <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
            <div className="text-xs">
              <div className="font-semibold">{c.parentCity || (c.tier === 2 ? 'Country fill' : 'Cell')}</div>
              <div className="opacity-80 capitalize">
                Tier {c.tier === 2 ? '2' : '1'} · {c.state}
                {c.leadsQualified ? ` · ${c.leadsQualified} qualified` : ''}
              </div>
            </div>
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  )
}
