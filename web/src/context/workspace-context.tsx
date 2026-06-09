// Workspace context - global "which portfolio company am I currently
// looking at" state. Picked from the sidebar's company switcher; persisted
// to localStorage so a refresh doesn't drop you back to the default.
//
// Two values matter:
//   • workspace: '' (no scope, "All Companies") | <portfolioCompany>
//   • availableWorkspaces: portfolioCompany strings the user can pick from.
//
// Pages that have a portfolio-company filter (Database, Coverage) read the
// workspace and use it as their DEFAULT filter on first paint. Per-page
// filter chips can still narrow further (or override to show "All companies"
// just on that page) - the workspace doesn't lock anything, it just sets
// the starting point.
//
// "" === "All Companies" mode is preserved as the default so single-user
// flows (one person managing several portfolio companies) don't lose the
// cross-view that exists today. The switcher is for multi-tenant teams who
// live inside one company's data 99% of the time.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { fetchPortfolioCompanies } from '@/lib/api'

interface WorkspaceCtx {
  workspace: string                       // '' = all companies
  setWorkspace: (w: string) => void
  availableWorkspaces: string[]           // portfolioCompany names from /api/icps/portfolio-companies
  loading: boolean
}

const Ctx = createContext<WorkspaceCtx | null>(null)

const STORAGE_KEY = 'bluebird:workspace'

// Special sentinel workspace for the Aspire CRM demo. Not a real portfolio
// company - selecting it collapses the sidebar to just Discover + Admin (see
// app-sidebar.tsx). Exempted from the "unknown workspace → reset" guard below
// so it survives reloads even though it isn't in availableWorkspaces.
export const CRM_DEMO_WORKSPACE = 'CRM DEMO'

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // Read initial value synchronously so first paint already has the right
  // workspace selected (avoids a one-frame "All Companies" flash on reload).
  // localStorage is sync; only fails in private-mode browsers where we just
  // fall back to ''.
  const [workspace, setWorkspaceState] = useState<string>(() => {
    try {
      return typeof window !== 'undefined' ? (window.localStorage.getItem(STORAGE_KEY) || '') : ''
    } catch {
      return ''
    }
  })
  const [availableWorkspaces, setAvailableWorkspaces] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  // Pull the list of available portfolio companies once on mount. Refreshes
  // are uncommon (an ICP gets created/deleted) - when that happens the user
  // can refresh the page; not worth a polling/socket setup just for this.
  useEffect(() => {
    let cancelled = false
    fetchPortfolioCompanies()
      .then((r) => {
        if (cancelled) return
        setAvailableWorkspaces(r.portfolioCompanies)
      })
      .catch(() => { /* non-fatal - leave the list empty */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Persist on every change so a hard reload returns to the same workspace.
  // Wrapped to absorb localStorage failures (private-mode browsers).
  const setWorkspace = useCallback((w: string) => {
    setWorkspaceState(w)
    try {
      if (w) window.localStorage.setItem(STORAGE_KEY, w)
      else window.localStorage.removeItem(STORAGE_KEY)
    } catch { /* no-op */ }
  }, [])

  // If the persisted workspace isn't in the live availableWorkspaces list
  // anymore (e.g. the ICP got deleted), drop it back to "" so the user
  // doesn't see ghost data on reload.
  useEffect(() => {
    if (!workspace) return
    if (workspace === CRM_DEMO_WORKSPACE) return // sentinel, not a real company
    if (loading) return
    if (availableWorkspaces.length === 0) return
    if (!availableWorkspaces.includes(workspace)) {
      setWorkspace('')
    }
  }, [workspace, availableWorkspaces, loading, setWorkspace])

  return (
    <Ctx.Provider value={{ workspace, setWorkspace, availableWorkspaces, loading }}>
      {children}
    </Ctx.Provider>
  )
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWorkspace must be used inside a WorkspaceProvider')
  return ctx
}
