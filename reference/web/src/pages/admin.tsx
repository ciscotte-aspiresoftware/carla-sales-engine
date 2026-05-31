// /admin - operator-only mode switch. Flipping to "Real" enables live
// Scrapingdog/Firecrawl/OpenAI/Apollo calls and unparks the grid sweep
// cron. Demo mode keeps the sweep paused and returns stubbed responses
// from every credit-spending endpoint.
//
// Intentionally not linked in the main sidebar nav — it sits under a tiny
// footer affordance so it doesn't tempt accidental clicks during a client
// demo.

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { GLASS } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { useMode } from '@/context/mode-context'
import { useBackground } from '@/context/background-context'
import { Loader2, ShieldCheck, FlaskConical, AlertTriangle, Image as ImageIcon, Square } from 'lucide-react'

export default function AdminPage() {
  const { mode, loading, updatedAt, setMode } = useMode()
  const { background, setBackground } = useBackground()
  const [pending, setPending] = useState<null | 'demo' | 'real'>(null)
  const [err, setErr] = useState<string | null>(null)

  async function flip(next: 'demo' | 'real') {
    if (next === mode || pending) return
    setErr(null)
    setPending(next)
    try {
      await setMode(next)
    } catch (e: any) {
      setErr(e?.message || 'Failed to switch mode')
    } finally {
      setPending(null)
    }
  }

  const isReal = mode === 'real'

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Switch the backend between demo (stubbed responses, no API credits) and real (live Scrapingdog, Firecrawl, OpenAI, Apollo).
        </p>
      </div>

      <Card className={cn(GLASS)}>
        <CardContent className="p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              isReal ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
            )}>
              {isReal ? <ShieldCheck className="h-5 w-5" /> : <FlaskConical className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Mode</h2>
                <Badge variant={isReal ? 'default' : 'secondary'} className={cn(
                  'uppercase tracking-wide text-[10px]',
                  isReal ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
                )}>
                  {loading ? 'loading' : mode}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {isReal
                  ? 'Live mode is on. Every classify, lead lookup, email generation and grid sweep will consume real API credits.'
                  : 'Demo mode is on. Endpoints return stubbed responses and the grid sweep cron is parked. Seeded fixture data is visible on Database/Accounts/Coverage.'}
              </p>
              {updatedAt > 0 && (
                <p className="text-[10px] text-muted-foreground/70 mt-1">
                  Last changed {new Date(updatedAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ModeOption
              active={!isReal}
              pending={pending === 'demo'}
              onClick={() => flip('demo')}
              icon={<FlaskConical className="h-4 w-4" />}
              title="Demo"
              line1="Stubbed responses"
              line2="No credits spent · seeded data shown"
              accent="sky"
            />
            <ModeOption
              active={isReal}
              pending={pending === 'real'}
              onClick={() => flip('real')}
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Real"
              line1="Live API calls"
              line2="Credits will be spent · demo data hidden"
              accent="emerald"
            />
          </div>

          {err && (
            <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={cn(GLASS)}>
        <CardContent className="p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-600 dark:text-purple-400">
              {background === 'photo' ? <ImageIcon className="h-5 w-5" /> : <Square className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Background</h2>
                <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30">
                  {background}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {background === 'photo'
                  ? 'The cinematic photo backdrop with drifting gradient blobs is on. Cards refract over it.'
                  : 'Flat backdrop — white in light mode, near-black in dark mode. Card surfaces are lifted for readability.'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <BackgroundOption
              active={background === 'photo'}
              onClick={() => setBackground('photo')}
              icon={<ImageIcon className="h-4 w-4" />}
              title="Photo"
              line1="Cinematic backdrop"
              line2="Default · refracting glass cards"
            />
            <BackgroundOption
              active={background === 'plain'}
              onClick={() => setBackground('plain')}
              icon={<Square className="h-4 w-4" />}
              title="Plain"
              line1="Flat white / black"
              line2="Theme-aware · less visual chatter"
            />
          </div>
        </CardContent>
      </Card>

      <Card className={cn(GLASS)}>
        <CardContent className="p-6 space-y-3">
          <h3 className="text-sm font-semibold">What changes when you switch</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg border border-white/40 dark:border-white/10 p-3 space-y-1">
              <div className="text-sky-700 dark:text-sky-300 font-semibold uppercase tracking-wide text-[10px]">Demo</div>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                <li>Seeded fixture data visible on Database / Accounts / Coverage</li>
                <li>Classify, leads, email generation return canned responses</li>
                <li>Sourcing search returns one placeholder row</li>
                <li>Grid sweep cron is parked</li>
                <li>No API credits consumed</li>
              </ul>
            </div>
            <div className="rounded-lg border border-white/40 dark:border-white/10 p-3 space-y-1">
              <div className="text-emerald-700 dark:text-emerald-300 font-semibold uppercase tracking-wide text-[10px]">Real</div>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                <li>Seeded fixture data hidden — only real sweep results show</li>
                <li>Classify hits Firecrawl + OpenAI</li>
                <li>Leads hit Apollo, email generation hits Apollo + OpenAI</li>
                <li>Sourcing search hits Scrapingdog (5 credits per query)</li>
                <li>Grid sweep cron runs against pending cells</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function BackgroundOption({
  active, onClick, icon, title, line1, line2,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  line1: string
  line2: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={active}
      className={cn(
        'h-auto justify-start gap-3 px-4 py-3 text-left rounded-xl border-white/40 dark:border-white/10',
        active && 'ring-2 ring-purple-500/60 bg-purple-500/10',
      )}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/40 dark:bg-white/10">
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{line1}</span>
        <span className="block text-[10px] text-muted-foreground/70">{line2}</span>
      </span>
    </Button>
  )
}

function ModeOption({
  active, pending, onClick, icon, title, line1, line2, accent,
}: {
  active: boolean
  pending: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  line1: string
  line2: string
  accent: 'sky' | 'emerald'
}) {
  const accentRing = accent === 'sky'
    ? 'ring-sky-500/60 bg-sky-500/10'
    : 'ring-emerald-500/60 bg-emerald-500/10'
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={active || pending}
      className={cn(
        'h-auto justify-start gap-3 px-4 py-3 text-left rounded-xl border-white/40 dark:border-white/10',
        active && `ring-2 ${accentRing}`,
      )}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/40 dark:bg-white/10">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{line1}</span>
        <span className="block text-[10px] text-muted-foreground/70">{line2}</span>
      </span>
    </Button>
  )
}
