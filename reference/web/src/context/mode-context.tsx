// App-wide demo/real mode. Mirrors the server's utils/mode.js state — the
// server is the source of truth (one flag, one process, shared across tabs),
// so this context just fetches it on mount and re-fetches after a flip.
//
// Pages can use `mode === 'demo'` to render banners or empty-state copy
// without making any extra requests of their own.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export type AppMode = 'demo' | 'real'

interface ModeCtx {
  mode: AppMode
  loading: boolean
  updatedAt: number
  setMode: (next: AppMode) => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<ModeCtx | null>(null)

export function ModeProvider({ children }: { children: ReactNode }) {
  // Default to 'demo' until the first /api/admin/mode response lands. A
  // wrong-for-one-frame value here is fine because no credit-spending UI
  // surface keys off mode in a way that would burn a request.
  const [mode, setModeState] = useState<AppMode>('demo')
  const [updatedAt, setUpdatedAt] = useState<number>(0)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/mode')
      const data = await res.json()
      if (data?.success && (data.mode === 'demo' || data.mode === 'real')) {
        setModeState(data.mode)
        setUpdatedAt(data.updatedAt || 0)
      }
    } catch { /* keep last-known mode on failure */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    refresh().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refresh])

  const setMode = useCallback(async (next: AppMode) => {
    const res = await fetch('/api/admin/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    })
    const data = await res.json()
    if (!data?.success) throw new Error(data?.error || 'Failed to update mode')
    setModeState(data.mode)
    setUpdatedAt(data.updatedAt || Date.now())
  }, [])

  return (
    <Ctx.Provider value={{ mode, loading, updatedAt, setMode, refresh }}>
      {children}
    </Ctx.Provider>
  )
}

export function useMode(): ModeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useMode must be used inside a ModeProvider')
  return ctx
}
