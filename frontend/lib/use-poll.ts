"use client"

/**
 * Visibility-aware polling helper.
 *
 * Behaviour:
 *   - Runs `fn` every `interval` ms while `enabled` is true.
 *   - Skips ticks while `document.hidden` (the browser tab is in the
 *     background). The first tick after the tab becomes visible fires
 *     immediately so the UI catches up — no waiting for the next interval.
 *   - Cancels cleanly on unmount or when `enabled` flips to false. Aborts
 *     any in-flight `fn` invocation via an `AbortSignal` (passed in as the
 *     callback argument).
 *   - One scheduled tick at a time per hook instance — no recursive
 *     setTimeout chains stacking up.
 *
 * Centralising this here means every poller across the app gets the same
 * visibility + cancellation discipline. Components don't manage timers,
 * cancel flags, or document-visibility listeners individually.
 *
 * Usage:
 *   usePoll(async (signal) => {
 *     const s = await api.getResearchStatus(id, { signal })
 *     setStatus(s)
 *     return s.step === "complete" ? "stop" : undefined
 *   }, { interval: 1500, enabled: researching })
 *
 * The callback can return the string `"stop"` to signal "we're done, stop
 * polling" — useful when the work has reached a terminal state.
 */
import { useEffect, useRef } from "react"

export interface UsePollOptions {
  /** Milliseconds between successful ticks. Defaults to 5000. */
  interval?: number
  /** When false, polling is suspended. Default true. */
  enabled?: boolean
  /** First-tick delay in ms. Defaults to 0 (fire immediately). */
  initialDelay?: number
}

export type PollFn = (signal: AbortSignal) => Promise<"stop" | void>

export function usePoll(fn: PollFn, opts: UsePollOptions = {}): void {
  const { interval = 5000, enabled = true, initialDelay = 0 } = opts

  // Keep the latest `fn` in a ref so the effect doesn't tear down + re-setup
  // on every parent render (which would defeat the whole point — recursive
  // setTimeout chains would still leak if we resubscribed on each render).
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    if (typeof window === "undefined") return // SSR safety

    let stopped = false
    let timer: number | undefined
    const controller = new AbortController()

    const schedule = (delay: number) => {
      if (stopped) return
      timer = window.setTimeout(tick, delay)
    }

    const tick = async () => {
      if (stopped) return
      // Tab in background — re-check shortly. We can't fully sleep until
      // visibility flips because some apps need event-loop liveness, but
      // skipping the work is what matters for CPU.
      if (typeof document !== "undefined" && document.hidden) {
        schedule(interval)
        return
      }
      try {
        const r = await fnRef.current(controller.signal)
        if (r === "stop") {
          stopped = true
          return
        }
      } catch {
        // Swallow — the poller's contract is "keep going on transient
        // errors". Component-level error UI is the consumer's job.
      }
      schedule(interval)
    }

    // The visibilitychange listener pulls the next tick forward when the
    // user returns to the tab so they don't sit looking at stale state for
    // up to `interval` ms.
    const onVisibility = () => {
      if (stopped) return
      if (document.hidden) return
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      // Immediate-but-not-recursive: schedule a 0ms tick so it lands on the
      // next macrotask rather than re-entering inside the event handler.
      schedule(0)
    }
    document.addEventListener("visibilitychange", onVisibility)

    schedule(initialDelay)

    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
      controller.abort()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [enabled, interval, initialDelay])
}
