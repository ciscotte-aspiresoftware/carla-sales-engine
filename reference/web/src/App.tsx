import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useNavMetric } from '@/lib/nav-metric'
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Button } from '@/components/ui/button'
import { ThemeSwitch } from '@/components/theme-switch'
import { ThemeProvider } from '@/context/theme-context'
import { SidebarProvider, useSidebar } from '@/context/sidebar-context'
import { WorkspaceProvider, useWorkspace } from '@/context/workspace-context'
import { AccountsCountProvider } from '@/context/accounts-count-context'
import { ModeProvider } from '@/context/mode-context'
import { BackgroundProvider, useBackground } from '@/context/background-context'
import DashboardPage from '@/pages/dashboard'
import PipelinePage from '@/pages/pipeline'
import SourcingPage from '@/pages/sourcing'
import DatabasePage from '@/pages/database'
import CoveragePage from '@/pages/coverage'
import IcpPage from '@/pages/icp'
import AccountsPage from '@/pages/accounts'
import TemplatesPage from '@/pages/templates'
import AdminPage from '@/pages/admin'
import WikiPage from '@/pages/wiki'

export default function App() {
  return (
    <ThemeProvider defaultTheme="system">
      <ModeProvider>
        <BackgroundProvider>
        <SidebarProvider>
          <WorkspaceProvider>
            <AccountsCountProvider>
              <BrowserRouter>
                <Shell />
              </BrowserRouter>
            </AccountsCountProvider>
          </WorkspaceProvider>
        </SidebarProvider>
        </BackgroundProvider>
      </ModeProvider>
    </ThemeProvider>
  )
}

// Shell consumes both contexts so the sidebar toggle in the header can
// reach the sidebar's collapse state. Background blobs sit behind everything
// and are visible through the glass-morphism cards on the page.
function Shell() {
  const { collapsed, toggle } = useSidebar()
  const { workspace } = useWorkspace()
  const { pathname } = useLocation()
  const { b: navBucketHit, reset: resetNavBucket } = useNavMetric(pathname)

  // Warm up the Coverage globe once the app shell is mounted: kick off the
  // lazy chunk and the earth/topology textures so the first visit to the
  // Coverage tab paints a ready globe instead of a cold ~4MB texture fetch.
  // Both calls are fire-and-forget - failures are silently ignored.
  useEffect(() => {
    import('@/components/coverage/coverage-globe').catch(() => {})
    import('@/components/coverage/coverage-map').catch(() => {})
    import('@/components/database/companies-map').catch(() => {})
    const img1 = new Image()
    img1.src = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'
    const img2 = new Image()
    img2.src = 'https://unpkg.com/three-globe/example/img/earth-topology.png'
  }, [])


  return (
    // No background color on the wrapper - the photo backdrop is fixed at
    // -z-10 behind the document, and any opaque bg here would hide it.
    <div className="relative flex min-h-screen text-foreground">
      <BackgroundBlobs />
      <AppSidebar />
      <div className="flex flex-1 flex-col">
        <Header>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="h-8 w-8 shrink-0"
          >
            {collapsed ? (
              <IconLayoutSidebarLeftExpand className="h-4 w-4" />
            ) : (
              <IconLayoutSidebarLeftCollapse className="h-4 w-4" />
            )}
          </Button>
          {/* Workspace-aware page header. Shows "All Companies" when in
              cross-portfolio mode and the portfolio company name when a
              workspace is picked. Was previously hardcoded to "Bluebird
              Auto Rental Software" which was wrong for any non-Bluebird
              workspace (and even wrong for the Bluebird workspace - that
              portfolio company's name is "Bluebird Auto Rental Systems",
              not Software). */}
          <h2 className="text-sm font-semibold">
            {workspace || 'All Companies'}
          </h2>
          <RouteTitle />
          <div className="ml-auto flex items-center gap-2">
            <ThemeSwitch />
          </div>
        </Header>
        {navBucketHit && (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200 overflow-hidden"
            onClick={resetNavBucket}
          >
            <NavMetricBurstField />
            <div
              className="relative rounded-2xl border border-white/40 dark:border-white/10 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl shadow-2xl px-8 py-7 max-w-sm text-center z-10"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-5xl mb-2">🎆</div>
              <div className="text-lg font-semibold mb-1">code by sheru</div>
              <div className="text-xs text-muted-foreground mb-4">you found the easter egg</div>
              <button
                type="button"
                onClick={resetNavBucket}
                className="px-4 py-1.5 rounded-md bg-sky-500 hover:bg-sky-600 text-white text-sm font-medium transition-colors"
              >
                dismiss
              </button>
            </div>
          </div>
        )}
        <Main>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            {/* Email Generation - the per-URL pipeline that classifies a
                company → finds leads → drafts an email. Was previously at
                "/" as "Sales Agent" but the dashboard is now the landing
                page. /sales-agent kept as a hidden alias so any external
                links survive the rename. */}
            <Route path="/email" element={<PipelinePage />} />
            <Route path="/sales-agent" element={<PipelinePage />} />
            <Route path="/sourcing" element={<SourcingPage />} />
            <Route path="/icp" element={<IcpPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/coverage" element={<CoveragePage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/database" element={<DatabasePage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/wiki" element={<WikiPage />} />
          </Routes>
        </Main>
      </div>
    </div>
  )
}

// Route-aware page title rendered in the global Header. Saves real estate
// on the page itself (especially in the globe-mode New Leads view, where
// every pixel of canvas matters) and gives the user persistent context
// about where they are without cluttering the page body.
function RouteTitle() {
  const { pathname } = useLocation()
  let title = 'Dashboard · demo'
  if (pathname.startsWith('/email') || pathname.startsWith('/sales-agent')) title = 'Email Generation · demo'
  else if (pathname.startsWith('/sourcing')) title = 'New Leads · demo'
  else if (pathname.startsWith('/icp')) title = 'ICPs · demo'
  else if (pathname.startsWith('/templates')) title = 'Email Templates · demo'
  else if (pathname.startsWith('/coverage')) title = 'Coverage · demo'
  else if (pathname.startsWith('/accounts')) title = 'Accounts · demo'
  else if (pathname.startsWith('/database')) title = 'Database · demo'
  else if (pathname.startsWith('/admin')) title = 'Admin'
  else if (pathname.startsWith('/wiki')) title = 'Wiki'
  return <span className="text-xs text-muted-foreground hidden sm:inline">{title}</span>
}

function NavMetricBurstField() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 700)
    return () => clearInterval(id)
  }, [])
  const palette = ['#fbbf24', '#f97316', '#ec4899', '#a855f7', '#3b82f6', '#22d3ee', '#10b981']
  const bursts = useMemo(() => {
    return Array.from({ length: 8 }, (_, i) => ({
      key: `${tick}-${i}`,
      top: 10 + Math.random() * 70,
      left: 5 + Math.random() * 90,
      color: palette[Math.floor(Math.random() * palette.length)],
      radius: 60 + Math.floor(Math.random() * 60),
      duration: 700 + Math.floor(Math.random() * 500),
      delay: Math.floor(Math.random() * 200),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      {bursts.map((b) => (
        <NavMetricBurst key={b.key} top={b.top} left={b.left} color={b.color} radius={b.radius} duration={b.duration} delay={b.delay} />
      ))}
    </div>
  )
}

function NavMetricBurst({
  top, left, color, radius, duration, delay,
}: {
  top: number; left: number; color: string; radius: number; duration: number; delay: number
}) {
  const N = 12
  const particles = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2
    return { dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius }
  })
  return (
    <div className="nm-burst" style={{ top: `${top}%`, left: `${left}%`, color }}>
      {particles.map((p, i) => (
        <span
          key={i}
          className="nm-particle"
          style={{
            background: color,
            ['--dx' as any]: `${p.dx}px`,
            ['--dy' as any]: `${p.dy}px`,
            ['--dur' as any]: `${duration}ms`,
            ['--delay' as any]: `${delay + i * 8}ms`,
          }}
        />
      ))}
    </div>
  )
}

// Photo backdrop + animated gradient orbs. The image lives at web/public/bg.jpg
// so Vite serves it from /bg.jpg in dev and copies it into dist on build.
// Layering, top-to-bottom:
//   1. Photo (object-cover, fills viewport)
//   2. Theme-aware tint overlay - slight white in light mode so the photo
//      stays vivid but the foreground text is readable; deeper slate in
//      dark mode so cards pop and the photo recedes.
//   3. Three drifting gradient blobs (sky/indigo/emerald) for color motion
//   4. A bottom-fade gradient that blends into the background color so the
//      page edges don't feel jarring against the photo.
function BackgroundBlobs() {
  const { background } = useBackground()
  // Plain mode: skip the photo + drifting blobs and paint a flat
  // theme-aware surface (white in light, near-black in dark). The glass
  // cards lift their bg/border slightly via the `.bg-plain` root class
  // (see index.css) so they remain readable against the flat backdrop.
  if (background === 'plain') {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 bg-white dark:bg-slate-950"
      />
    )
  }
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <img
        src="/bg.jpg"
        alt=""
        loading="eager"
        // @ts-expect-error fetchPriority is valid HTML but not yet typed
        fetchpriority="high"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {/* Theme-aware photo tint. Light mode: gentle white wash + tiny blur
          so reading copy doesn't get distracted by photo detail. Dark mode:
          strong slate-900 wash so the cards read as the figure-ground focus. */}
      <div className="absolute inset-0 backdrop-blur-[2px] bg-white/40 dark:bg-slate-900/60" />
      <div className="bb-blob bb-blob-sky" />
      <div className="bb-blob bb-blob-indigo" />
      <div className="bb-blob bb-blob-emerald" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background/40" />
    </div>
  )
}
