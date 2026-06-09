// Visibility-aware polling hook.
//
// Standard `setInterval` polling has two annoying properties: it keeps ticking
// while the tab is in the background (waste of battery + Render quota on a
// page nobody is looking at), and it doesn't cancel cleanly when the component
// unmounts mid-request. This hook fixes both:
//
//   • Pauses while document.hidden is true. Fires immediately on tab show
//     so the operator's first glance is up to date.
//   • Hands the callback an AbortSignal so its fetch() can be cancelled
//     on unmount or when polling is paused.
//   • Caller can stop polling early by returning the string "stop" from
//     the callback (e.g. once a job has finished).
//
// Mirrors the pattern Aaron SDR uses in his frontend/lib/use-poll.ts - same
// shape so swapping in / out is easy.

import { useEffect, useRef } from 'react'

type PollResult = void | undefined | 'stop'

export interface UsePollOptions {
  // ms between ticks. Defaults to 5000.
  intervalMs?: number
  // ms before the FIRST tick fires. Defaults to 0 (fire immediately).
  initialDelayMs?: number
  // When false, the hook is dormant entirely - no ticks, no listeners.
  // Useful for "only poll while a job is in flight" patterns.
  enabled?: boolean
}

export function usePoll(callback: (signal: AbortSignal) => Promise<PollResult>, opts: UsePollOptions = {}) {
  const { intervalMs = 5000, initialDelayMs = 0, enabled = true } = opts
  // Keep the latest callback in a ref so effect deps stay stable - re-running
  // the effect on every render would tear down and re-create the timer on
  // every parent render, defeating the polling cadence.
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let controller = new AbortController()

    const tick = async () => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.hidden) {
        // Skip this tick - we'll fire as soon as the tab comes back.
        timer = setTimeout(tick, intervalMs)
        return
      }
      controller = new AbortController()
      try {
        const r = await cbRef.current(controller.signal)
        if (r === 'stop') { stopped = true; return }
      } catch { /* swallow - the callback decides what to do with errors */ }
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }

    const onVisible = () => {
      if (stopped) return
      if (!document.hidden) {
        // Drop any pending wait + tick now.
        if (timer) { clearTimeout(timer); timer = null }
        tick()
      }
    }

    timer = setTimeout(tick, initialDelayMs)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      controller.abort()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [intervalMs, initialDelayMs, enabled])
}