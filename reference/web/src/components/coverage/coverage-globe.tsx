// Coverage globe - visualizes the per-cell sweep state for an ICP.
//
// Cells are rendered via react-globe.gl's `pointsData` (WebGL spheres)
// instead of `htmlElementsData` (CSS3D DOM divs). The htmlElements layer
// in 2.27.x throws a hot loop of `Cannot read properties of undefined
// (reading 'length')` errors from `isBehindGlobe` whenever data updates
// land while the camera is animating, which froze the canvas and ate
// pointer events - making the globe look stuck and non-interactive.
// pointsData is pure-WebGL so it doesn't suffer from that bug.
//
// Scanning cells additionally render an animated `ringsData` wave that
// expands and fades - a more globe-appropriate "this cell is being
// processed right now" cue than the old CSS pulse animation.
//
// Pre-zoom: when the `centerLat/centerLng` props change (e.g. user
// switches ICP region), the globe animates to that point with a 1.4s
// transition.

import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react'
import Globe from 'react-globe.gl'
import { useTheme } from '@/context/theme-context'

export interface CoverageCell {
  id: string
  lat: number
  lng: number
  state: 'pending' | 'scanning' | 'complete' | 'empty'
  /** 1 = dense city sub-cell (5km), 2 = country-fill (12km). Drives styling. */
  tier?: number
  parentCity?: string
  placesFound?: number
  leadsQualified?: number
  /** Per-cell Scrapingdog search radius in km. Drives the translucent
      coverage halo around the selected cell on the map. */
  radiusKm?: number
  /** Density tier the seeder placed this cell into - 'urban' / 'suburban'
      / 'rural' / 'airport' / 'sparse'. Useful for tooltips/debug. */
  placeTier?: string
  /** Origin source - 'populated' / 'airport' / 'sparse'. Drives halo
      stroke colour on the map. */
  placeSource?: string
}

interface Props {
  cells: CoverageCell[]
  /** Globe pre-zooms to this lat/lng on mount and on change. */
  centerLat: number
  centerLng: number
  /** altitude - 1.5 ≈ city zoom, 2.5 ≈ country zoom. */
  altitude?: number
  /** Fired when a cell DOM element is clicked. */
  onCellClick?: (cell: CoverageCell) => void
  /** ID of the currently-selected cell - gets a ring highlight. */
  selectedCellId?: string | null
  /** Fired on every zoom change with the camera's current pov. The page
      uses this to (a) flip into the 2D map view when the user scrolls in
      past a city-scale threshold, and (b) hand the map an initial center
      matching wherever the user was looking on the globe. */
  onZoomChange?: (pov: { lat: number; lng: number; altitude: number }) => void
}

const COUNTRIES_GEOJSON_URL =
  'https://raw.githubusercontent.com/vasturiano/react-globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson'

function useIsDark(): boolean {
  const { theme } = useTheme()
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setSystemDark(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return systemDark
}

export default function CoverageGlobe({
  cells,
  centerLat,
  centerLng,
  altitude = 1.5,
  onCellClick,
  selectedCellId,
  onZoomChange,
}: Props) {
  const globeRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Initial size is measured synchronously from the container in the first
  // useLayoutEffect below. Starting with 0/0 means the Globe initially renders
  // an empty canvas; the layout effect runs before paint and supplies real
  // dimensions before anything is shown. (Previously this was a fixed
  // 800×600 fallback, which caused a one-frame size flash on tab re-open
  // because lazy() remounts the component every time.)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [countries, setCountries] = useState<any[]>([])
  // Tracks whether react-globe.gl has fired onGlobeReady. Until then, calling
  // pointOfView() is a no-op (the internal three.js controls aren't wired
  // yet) - that's why the first pre-zoom effect could silently miss.
  const [globeReady, setGlobeReady] = useState(false)
  // Becomes true once the camera has been snapped to the target lat/lng on
  // first mount. Drives the fade-in: until then, the Globe canvas is hidden
  // so the user doesn't see the default (0,0,2.5) "tiny earth in the middle"
  // for the few frames before our pointOfView() snap takes effect.
  const [cameraSettled, setCameraSettled] = useState(false)
  // Latest props captured into a ref so onGlobeReady (which only fires once)
  // can read fresh values without stale closures.
  const propsRef = useRef({ centerLat, centerLng, altitude })
  useEffect(() => {
    propsRef.current = { centerLat, centerLng, altitude }
  }, [centerLat, centerLng, altitude])
  // Theme-aware tinting was removed - the globe + tiles render the same
  // in light and dark mode now, since night-earth/dark-tiles made dots
  // hard to read against an already-dark UI. useIsDark hook stays in the
  // file for any future use.
  void useIsDark

  // Country polygons (same dotted-globe backdrop as the picker).
  useEffect(() => {
    let cancelled = false
    fetch(COUNTRIES_GEOJSON_URL)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        setCountries(Array.isArray(data?.features) ? data.features : [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Synchronous first measurement before paint. Eliminates the one-frame
  // size flash where the canvas renders at default 800×600 then snaps to
  // the real container size. Runs before the browser paints - required to
  // avoid the visible jump on tab re-open (which remounts the component).
  useLayoutEffect(() => {
    if (!containerRef.current) return
    const r = containerRef.current.getBoundingClientRect()
    const w = Math.floor(r.width), h = Math.floor(r.height)
    if (w > 0 && h > 0 && (w !== size.width || h !== size.height)) {
      setSize({ width: w, height: h })
    }
    // Intentionally only on mount - subsequent updates flow through the
    // ResizeObserver below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resize observer - keeps the canvas filling the parent on subsequent
  // resizes (window resize, sidebar collapse, etc.).
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (!r) return
      const w = Math.floor(r.width), h = Math.floor(r.height)
      if (w !== size.width || h !== size.height) setSize({ width: w, height: h })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [size.width, size.height])

  // Configure controls + snap to the target lat/lng AS SOON AS the globe
  // reports ready. Doing both inline in handleGlobeReady is more reliable
  // than splitting them into separate effects.
  //
  // First-mount snap is instant (transition duration = 0) because animating
  // from the default (0, 0, 2.5) - which renders as a "tiny earth in the
  // middle" - to the target city looks like a glitch, especially on tab
  // re-opens (the component is lazy-loaded and remounts every visit).
  // Subsequent re-zooms (user changes ICP / city) keep the 1400ms animation
  // because they're a deliberate user action and the smooth flight conveys
  // "we're moving from where you were to where you asked for".
  //
  // The cameraSettled flag below drives a fade-in on the canvas wrapper -
  // until the snap completes, the canvas is opacity-0 so the user never
  // sees the default-camera flash.
  const handleGlobeReady = () => {
    setGlobeReady(true)
    const g = globeRef.current
    if (!g) return
    if (g.controls) {
      const c = g.controls()
      if (c) {
        c.autoRotate = false
        c.enableZoom = true
        c.enableRotate = true   // explicit - was relying on default
        c.enablePan = false
      }
    }
    const { centerLat: lat, centerLng: lng, altitude: alt } = propsRef.current
    if (g.pointOfView && Number.isFinite(lat) && Number.isFinite(lng)) {
      // Instant snap - duration 0 sets the camera state synchronously rather
      // than animating from the default POV. No setTimeout needed because
      // we're not racing the OrbitControls animation loop; we're just
      // setting state.
      g.pointOfView({ lat, lng, altitude: alt }, 0)
    }
    // One frame after the snap, reveal the canvas. requestAnimationFrame
    // ensures the next paint includes both the new camera POV AND the fade-
    // in transition kicking off, so the user sees a clean zoomed-in earth
    // rather than the default-then-snap.
    requestAnimationFrame(() => setCameraSettled(true))
  }

  // Re-zoom whenever the target center changes after the globe is ready
  // (e.g. user switches ICP / city). Initial pre-zoom is handled in
  // handleGlobeReady above.
  useEffect(() => {
    if (!globeReady) return
    if (!globeRef.current?.pointOfView) return
    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) return
    globeRef.current.pointOfView(
      { lat: centerLat, lng: centerLng, altitude },
      1400
    )
  }, [centerLat, centerLng, altitude, globeReady])

  // Country hex polygons sit on top of the textured sphere as a contrast
  // overlay. White-ish dots over the blue marble keep country shapes legible
  // regardless of UI theme.
  const hexColor = () => 'rgba(255, 255, 255, 0.55)'
  const atmosphereColor = '#6366f1'

  // Earth texture - always the daytime blue marble. We tried theme-swapping
  // to earth-night.jpg in dark mode, but the result was an almost-black globe
  // that lost continent contrast and made cell dots hard to read. Forcing
  // the light texture keeps the visualization legible whatever the theme is.
  const globeImageUrl = '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg'
  const bumpImageUrl = '//unpkg.com/three-globe/example/img/earth-topology.png'

  // Build per-cell point markers. Each point carries its own color +
  // radius + altitude derived from the cell's state and tier - Tier-1
  // cells are bigger and more saturated than Tier-2 country-fill so the
  // dense metro grids stay the visual focus.
  const points = useMemo(() => {
    return cells.map((c) => {
      const tier = c.tier === 2 ? 2 : 1
      const isSelected = selectedCellId === c.id
      // Color per state. Hex strings keep three.js Color parsing trivial.
      let color = '#7dd3fc' // sky-300, pending
      if (c.state === 'scanning') color = '#f87171' // red-400
      else if (c.state === 'complete') color = '#4ade80' // emerald-400
      else if (c.state === 'empty') color = '#94a3b8' // slate-400
      // Cell radii. With 8 km grid spacing and 50 cells packed into a 30 km
      // London radius, dots > ~4 km wide overlap and merge into a blob.
      // Tier-2 country-fill is smaller so dense metros stay dominant.
      const baseRadius = tier === 2 ? 0.04 : 0.07
      const radius = isSelected
        ? baseRadius * 2.2
        : c.state === 'scanning'
          ? baseRadius * 1.5
          : c.state === 'empty'
            ? baseRadius * 0.6
            : baseRadius
      // Altitude is kept near zero so the WebGL cylinders pointsData renders
      // read as FLAT discs from any camera angle. Anything above ~0.005 made
      // the cells look like tall coloured columns blocking the city beneath.
      const altitude = isSelected
        ? 0.004
        : c.state === 'scanning'
          ? 0.003
          : 0.001
      return { ...c, __color: color, __radius: radius, __altitude: altitude }
    })
  }, [cells, selectedCellId])

  // Pulse rings only on `scanning` cells. ringsData is animated by react-
  // globe.gl natively (no per-frame React updates needed) and renders in
  // WebGL, so this stays cheap even with dozens of concurrent rings.
  const rings = useMemo(
    () => cells.filter((c) => c.state === 'scanning').map((c) => ({ lat: c.lat, lng: c.lng })),
    [cells]
  )

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {/* Fade-in wrapper - hides the canvas until the camera has been snapped
          to the target lat/lng on first mount. Without this, the default
          react-globe.gl camera (0, 0, 2.5) - which looks like a tiny earth
          in the middle of the viewport - is briefly visible before our
          pointOfView() snap takes effect. The 250ms transition kicks in
          once cameraSettled flips true, so the globe gently appears at the
          right zoom level rather than blinking in. */}
      <div
        className="absolute inset-0 transition-opacity duration-300 ease-out"
        style={{ opacity: cameraSettled ? 1 : 0 }}
      >
      <Globe
        ref={globeRef}
        onGlobeReady={handleGlobeReady}
        onZoom={(pov: any) => {
          if (onZoomChange && pov && Number.isFinite(pov.altitude) && Number.isFinite(pov.lat) && Number.isFinite(pov.lng)) {
            onZoomChange({ lat: pov.lat, lng: pov.lng, altitude: pov.altitude })
          }
        }}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl={globeImageUrl}
        bumpImageUrl={bumpImageUrl}
        showAtmosphere
        atmosphereColor={atmosphereColor}
        atmosphereAltitude={0.15}
        hexPolygonsData={countries}
        hexPolygonResolution={4}
        hexPolygonMargin={0.5}
        hexPolygonUseDots
        hexPolygonColor={hexColor}
        // ── Cell point markers ──────────────────────────────────────────
        pointsData={points}
        pointLat="lat"
        pointLng="lng"
        pointAltitude={(p: any) => p.__altitude}
        pointRadius={(p: any) => p.__radius}
        pointColor={(p: any) => p.__color}
        pointResolution={6}
        pointsMerge={false}
        pointLabel={(p: any) => {
          const tier = p.tier === 2 ? 'Tier 2 (country fill)' : 'Tier 1'
          const label = p.parentCity || (p.tier === 2 ? 'country fill' : 'cell')
          const stats = p.leadsQualified
            ? ` · ${p.leadsQualified} qualified`
            : p.placesFound
              ? ` · ${p.placesFound} places`
              : ''
          return `<div style="background:rgba(15,23,42,0.92);color:#f8fafc;padding:4px 8px;border-radius:6px;font-size:12px;border:1px solid rgba(56,189,248,0.4);">
            <div style="font-weight:600">${label}</div>
            <div style="opacity:0.8">${tier} · ${p.state}${stats}</div>
          </div>`
        }}
        onPointClick={(p: any) => {
          if (onCellClick) onCellClick(p)
        }}
        // ── Animated pulse rings on cells that are mid-sweep ───────────
        // Sized to city-zoom (small radius, fast cadence). At country
        // zoom these still read clearly because the ring color fades to
        // transparent at full propagation.
        ringsData={rings}
        ringLat="lat"
        ringLng="lng"
        ringMaxRadius={0.35}
        ringPropagationSpeed={0.4}
        ringRepeatPeriod={1100}
        ringColor={() => (t: number) => `rgba(248, 113, 113, ${1 - t})`}
        ringAltitude={0.004}
      />
      </div>
    </div>
  )
}
