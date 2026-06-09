// GlobePlaceholder - pixel-perfect-ish "globe is loading" stand-in shown
// during the two cold-start gaps that used to leave the Coverage container
// empty:
//
//   1) Suspense fallback for the lazy-loaded CoverageGlobe chunk - covers
//      the ~50-300ms of JS download + parse.
//   2) Inside CoverageGlobe itself, until the camera has snapped to the
//      target position (`cameraSettled === false`) - covers another ~200-
//      600ms of WebGL context setup, shader compile, and texture upload.
//
// The visual is a circular crop of the earth texture we already preload at
// app boot (App.tsx → new Image()), wrapped in an outer atmosphere ring and
// an inset radial shadow that fakes limb-darkening so it reads as a sphere.
// Nothing animates beyond a small spinner so it stays cheap.
//
// Pointer-events:none so it doesn't intercept clicks on top of (or behind)
// the real canvas once it starts painting.

import { Loader2 } from 'lucide-react'

const EARTH_TEXTURE = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'

export default function GlobePlaceholder({
  // When used as an overlay inside CoverageGlobe, the parent fades the real
  // canvas in over 300ms; the placeholder should fade out in parallel.
  // `hidden=true` triggers that fade-out. Default false = fully visible.
  hidden = false,
  label = 'Loading globe…',
}: {
  hidden?: boolean
  label?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={[
        'absolute inset-0 pointer-events-none',
        'flex flex-col items-center justify-center gap-3',
        'transition-opacity duration-300 ease-out',
        hidden ? 'opacity-0' : 'opacity-100',
      ].join(' ')}
    >
      {/* Outer atmosphere ring - soft sky-blue halo around the sphere.
          Sits behind the textured disc and bleeds slightly past its edge. */}
      <div className="relative">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              'radial-gradient(circle, rgba(56,189,248,0.18) 60%, rgba(56,189,248,0.05) 78%, transparent 85%)',
            transform: 'scale(1.18)',
          }}
        />
        {/* The "sphere" itself - earth texture, circle-cropped, with an
            inset radial shadow to fake limb darkening. We don't animate
            rotation; the goal is "globe is here" not "this is a 3D scene". */}
        <div
          className="relative h-48 w-48 rounded-full overflow-hidden"
          style={{
            backgroundImage: `url(${EARTH_TEXTURE})`,
            // Push the texture so we land on Europe/Africa-ish instead of
            // the dateline. Equirectangular textures repeat, so this is
            // just an aesthetic choice for the loading state.
            backgroundSize: '200% 100%',
            backgroundPosition: '30% 50%',
            // Inset shadow = limb darkening. Outer shadow = subtle lift off
            // the page so it doesn't look stuck to the container.
            boxShadow:
              'inset -18px -18px 50px rgba(0,0,0,0.55), inset 12px 12px 30px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.25)',
          }}
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  )
}