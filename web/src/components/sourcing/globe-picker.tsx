// 3D globe picker for the New Leads page.
// Uses react-globe.gl (three.js under the hood). Renders a wireframe-ish
// dotted globe with the prefilled cities as clickable markers + a free-form
// click handler that captures any point on the surface as {lat, lng}.
//
// Country polygons fetched from a public CDN on mount (~80KB, cached).
// We deliberately don't bundle them - keeps the main JS bundle slim and
// lets the polygons cache across sessions/projects via the CDN.
//
// This component is heavy (three.js ≈ 600KB gzipped), so it's lazy-loaded
// from the sourcing page via React.lazy + Suspense.

import { useEffect, useRef, useState, useMemo } from 'react'
import Globe from 'react-globe.gl'
import * as THREE from 'three'
import { useTheme } from '@/context/theme-context'

export interface GlobeCity {
  key: string
  label: string
  country: string
  lat: number
  lng: number
}

export type GlobeSelection =
  | { type: 'city'; cityKey: string; lat: number; lng: number; label: string }
  | { type: 'point'; lat: number; lng: number; label: string }

interface Props {
  cities: GlobeCity[]
  selection: GlobeSelection | null
  onSelect: (s: GlobeSelection) => void
  /** Fixed height in px. Ignored when `fill` is true. */
  height?: number
  /** When true, the globe stretches to its parent's full width AND height
      via a ResizeObserver. Use this when the picker is the page's backdrop
      so it fills the viewport (minus sidebar + header). */
  fill?: boolean
  /** Extra hint className for the inner hint pill. */
  hintClassName?: string
}

// Effective dark-mode detection. Theme can be 'system' so we have to peek
// at prefers-color-scheme to know the actual rendered mode.
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

const COUNTRIES_GEOJSON_URL =
  'https://raw.githubusercontent.com/vasturiano/react-globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson'

export default function GlobePicker({ cities, selection, onSelect, height = 480, fill = false, hintClassName }: Props) {
  const globeRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Track BOTH width and height when fill=true so the globe expands with
  // its parent. When fill=false we just track width and use the prop height.
  const [size, setSize] = useState({ width: 800, height: fill ? 600 : height })
  const [countries, setCountries] = useState<any[]>([])
  const isDark = useIsDark()

  // ─── Fetch country polygons once on mount ────────────────────────────
  useEffect(() => {
    let cancelled = false
    fetch(COUNTRIES_GEOJSON_URL)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const features = Array.isArray(data?.features) ? data.features : []
        setCountries(features)
      })
      .catch((err) => console.warn('[Globe] failed to load countries:', err.message))
    return () => {
      cancelled = true
    }
  }, [])


  // ─── Resize observer for responsive sizing ───────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      const newW = Math.floor(rect.width)
      const newH = fill ? Math.floor(rect.height) : height
      if (newW !== size.width || newH !== size.height) {
        setSize({ width: newW, height: newH })
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [size.width, size.height, fill, height])

  // ─── Auto-rotate when idle ───────────────────────────────────────────
  // controls() comes from three's OrbitControls - has autoRotate flag we
  // can flip. Stops automatically while the user drags (built-in).
  useEffect(() => {
    const globe = globeRef.current
    if (!globe?.controls) return
    const controls = globe.controls()
    if (controls) {
      controls.autoRotate = true
      controls.autoRotateSpeed = 0.35
      controls.enableZoom = true
      controls.enablePan = false
    }
  }, [countries.length])

  // ─── Animate to selection ────────────────────────────────────────────
  useEffect(() => {
    if (!selection || !globeRef.current?.pointOfView) return
    globeRef.current.pointOfView(
      { lat: selection.lat, lng: selection.lng, altitude: 1.6 },
      1400
    )
  }, [selection])

  // ─── Click handlers ──────────────────────────────────────────────────
  function handlePointClick(point: any) {
    if (!point) return
    onSelect({
      type: 'city',
      cityKey: point.key,
      lat: point.lat,
      lng: point.lng,
      label: point.label,
    })
  }

  function handleGlobeClick({ lat, lng }: { lat: number; lng: number }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    onSelect({
      type: 'point',
      lat,
      lng,
      label: `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`,
    })
  }

  // ─── Marker data ─────────────────────────────────────────────────────
  // Cities + (optionally) a free-point marker from the current selection.
  // Selected city/free-point gets a brighter ring so it stands out.
  const cityPoints = cities.map((c) => {
    const isSelected = selection?.type === 'city' && selection.cityKey === c.key
    return {
      ...c,
      __isCity: true,
      __color: isSelected ? '#f87171' /* red-400 */ : (isDark ? '#38bdf8' /* sky-400 */ : '#6366f1' /* indigo-500 */),
      __radius: isSelected ? 0.55 : 0.35,
      __altitude: isSelected ? 0.04 : 0.015,
    }
  })

  const freePointMarker =
    selection?.type === 'point'
      ? [
          {
            lat: selection.lat,
            lng: selection.lng,
            label: selection.label,
            __isCity: false,
            __color: '#f87171',
            __radius: 0.55,
            __altitude: 0.04,
          },
        ]
      : []

  // allPoints is finalized BELOW (after the NL animated points are
  // computed) so we can include them in the same pointsData layer.

  // Hex polygon color - translucent so the photo backdrop bleeds through.
  // Default = sky (dark) / indigo (light); Netherlands gets a green
  // override so Carla's first EU market visually pops on the globe.
  const HIGHLIGHT_COUNTRIES = new Set(['NL', 'Netherlands'])
  const HIGHLIGHT_COLOR_DARK = 'rgba(74, 222, 128, 0.65)'   // emerald-400 @ 0.65
  const HIGHLIGHT_COLOR_LIGHT = 'rgba(16, 185, 129, 0.65)'  // emerald-500 @ 0.65
  const DEFAULT_COLOR_DARK = 'rgba(125, 211, 252, 0.55)'    // sky-300
  const DEFAULT_COLOR_LIGHT = 'rgba(99, 102, 241, 0.55)'    // indigo-500

  const hexColor = (feature: any) => {
    const props = feature?.properties || {}
    const iso = props.ISO_A2 || props.iso_a2 || ''
    const name = props.ADMIN || props.NAME || ''
    if (HIGHLIGHT_COUNTRIES.has(iso) || HIGHLIGHT_COUNTRIES.has(name)) {
      return isDark ? HIGHLIGHT_COLOR_DARK : HIGHLIGHT_COLOR_LIGHT
    }
    return isDark ? DEFAULT_COLOR_DARK : DEFAULT_COLOR_LIGHT
  }
  const atmosphereColor = isDark ? '#38bdf8' : '#6366f1'

  const allPoints = [...cityPoints, ...freePointMarker]


  // The big see-through trick. By default react-globe.gl renders an opaque
  // sphere underneath the hex polygons - that's why the globe looked like
  // a solid black ball even with `globeImageUrl={null}`. We swap in our own
  // MeshBasicMaterial with near-zero opacity so the sphere is visually
  // gone, but still rendered (so threejs raycasting fires onGlobeClick on
  // free-point taps). Useful side-effect: the photo backdrop bleeds right
  // through the globe - only the dotted hex grid is opaque-ish.
  const transparentGlobeMaterial = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({
      color: isDark ? 0x0f172a : 0xf1f5f9,
      transparent: true,
      opacity: 0.05,
      depthWrite: false, // don't block the photo's depth buffer
    })
    return mat
  }, [isDark])

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      style={fill ? { width: '100%', height: '100%' } : { height }}
    >
      <Globe
        ref={globeRef}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        globeMaterial={transparentGlobeMaterial}
        showAtmosphere
        atmosphereColor={atmosphereColor}
        atmosphereAltitude={0.15}
        // ── Country DOT GRID layer ──────────────────────────────────────
        // GeoJSON country polygons rendered as small dots at H3 hex
        // centers - gives the dotted-globe wireframe look. Single uniform
        // color across all countries. Resolution 4 ≈ 7× more cells per
        // face than 3, giving a denser halftone. Margin nudged down so
        // the higher density doesn't space the dots out further apart.
        hexPolygonsData={countries}
        hexPolygonResolution={4}
        hexPolygonMargin={0.3}
        hexPolygonUseDots
        hexPolygonColor={hexColor}
        // Marker layer - cities + optional free-point selection. Stable
        // dataset (changes only on click), so default merging is fine and
        // city extrusion behaves correctly.
        pointsData={allPoints}
        pointLat="lat"
        pointLng="lng"
        pointAltitude={(p: any) => p.__altitude}
        pointRadius={(p: any) => p.__radius}
        pointColor={(p: any) => p.__color}
        pointLabel={(p: any) =>
          `<div style="background:rgba(15,23,42,0.92);color:#f8fafc;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:600;border:1px solid rgba(56,189,248,0.4);">${escapeHtml(p.label)}</div>`
        }
        onPointClick={handlePointClick}
        onGlobeClick={handleGlobeClick}
      />
      {/* Hint overlay so users know the click options. pointer-events-none
          so it doesn't block the user from clicking the globe area beneath. */}
      <div className={`absolute bottom-3 left-3 rounded-md border border-white/30 dark:border-white/10 bg-white/40 dark:bg-slate-900/50 backdrop-blur-md px-3 py-2 text-[11px] text-foreground/80 shadow-sm pointer-events-none ${hintClassName || ''}`}>
        <div>● Click a city marker to select it</div>
        <div>● Click anywhere on the globe for a free point</div>
        <div>● Drag to rotate · scroll to zoom</div>
      </div>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]!))
}
