// Background-style preference. "plain" is the default - flat white in
// light mode / near-black in dark mode, the calmer choice for long data-
// review sessions. "photo" swaps in the cinematic backdrop (bg.jpg +
// drifting blobs) for operators who want the richer look.
//
// Local-only, persisted to localStorage. No backend involvement; this is
// purely a viewer preference.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export type BackgroundStyle = 'photo' | 'plain'

interface BackgroundCtx {
  background: BackgroundStyle
  setBackground: (next: BackgroundStyle) => void
}

const Ctx = createContext<BackgroundCtx | null>(null)
const STORAGE_KEY = 'carla:background'

export function BackgroundProvider({ children }: { children: ReactNode }) {
  const [background, setBackgroundState] = useState<BackgroundStyle>(() => {
    try {
      const v = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
      // Honour an explicit stored "photo"; everything else (no value, "plain",
      // garbage) lands on plain - the new default.
      return v === 'photo' ? 'photo' : 'plain'
    } catch { return 'plain' }
  })

  // Mirror the choice onto <html> via a class so global CSS rules can
  // strengthen card surfaces / borders when the rich backdrop is gone.
  // (Pure CSS lookup is cheaper than threading the value through every
  // glass card.)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.toggle('bg-plain', background === 'plain')
    root.classList.toggle('bg-photo', background === 'photo')
  }, [background])

  const setBackground = useCallback((next: BackgroundStyle) => {
    setBackgroundState(next)
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* no-op */ }
  }, [])

  return (
    <Ctx.Provider value={{ background, setBackground }}>
      {children}
    </Ctx.Provider>
  )
}

export function useBackground(): BackgroundCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useBackground must be used inside a BackgroundProvider')
  return ctx
}
