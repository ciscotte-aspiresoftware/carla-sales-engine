// Live count of pending-review accounts, used by the sidebar pill so the
// rep can see at a glance how many qualified leads are waiting for their
// verdict without opening the Accounts page.
//
// Scope follows the current workspace - picking NedFox in the sidebar
// shrinks the count to NedFox's pending accounts only. Switching back
// to "All Companies" expands it to the cross-portfolio total.
//
// The Accounts page calls `refresh()` after every confirm/reject/undo
// so the pill stays in sync without polling. A safety-net poll runs
// every 60 s while the tab is focused to catch state created by the
// backend cron (auto-fanout sweeps that drop new pending items into the
// queue) without the user having to manually reload.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchCompanies } from '@/lib/api'
import { useWorkspace } from './workspace-context'
import { API_BASE } from '@/lib/api-base'

interface AccountsCountCtx {
  pendingCount: number
  refresh: () => Promise<void>
  loading: boolean
}

const Ctx = createContext<AccountsCountCtx | null>(null)

// Background-refresh cadence. 60 s feels right: short enough that a rep
// notices the cron added new pending items within a coffee break, long
// enough that idle tabs don't pound the API.
const POLL_INTERVAL_MS = 60_000

export function AccountsCountProvider({ children }: { children: ReactNode }) {
  const { workspace } = useWorkspace()
  const [pendingCount, setPendingCount] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(false)
  // Track the in-flight request so a rapid workspace switch cancels the
  // stale fetch instead of letting it overwrite the new value.
  const reqIdRef = useRef(0)

  const refresh = useCallback(async () => {
    const reqId = ++reqIdRef.current
    setLoading(true)
    try {
      // Workspace-scoped count needs TWO things:
      //   1. The companies in the workspace (portfolioCompany filter on
      //      the backend - keeps companies with ANY classification under a
      //      workspace ICP).
      //   2. The set of ICP ids the workspace owns - so when we then count
      //      pending (company, icp) PAIRS, we only count pairs under the
      //      workspace's own ICPs. Without (2) the loop was double-counting:
      //      a company classified under both bluebird AND nedfox-thrift
      //      would contribute its nedfox-thrift pending pair to the Bluebird
      //      sidebar pill, inflating it by every cross-portfolio classify.
      const [companiesRes, ownedIds] = await Promise.all([
        fetchCompanies(workspace ? { portfolioCompany: workspace } : {}),
        workspace ? fetchWorkspaceIcpIds(workspace) : Promise.resolve(null),
      ])
      if (reqId !== reqIdRef.current) return  // a newer fetch superseded us
      // Pending across every (company, icp) pair: classifier said is_match
      // AND no review yet. Same definition the Accounts page uses for the
      // Pending lane. When `ownedIds` is non-null (workspace picked) we
      // also gate by ICP membership so foreign-portfolio classifications
      // on the same company don't double-count.
      let pending = 0
      for (const c of companiesRes.companies) {
        if (!c.classifications) continue
        for (const [icpId, cls] of Object.entries(c.classifications)) {
          if (ownedIds && !ownedIds.has(icpId)) continue
          if (cls.is_match !== true) continue
          if (c.reviews?.[icpId]) continue
          pending++
        }
      }
      setPendingCount(pending)
    } catch {
      // Soft-fail - leave the previous count visible rather than blanking
      // the pill on a transient error.
    } finally {
      if (reqId === reqIdRef.current) setLoading(false)
    }
  }, [workspace])

  // Initial fetch + refetch on workspace change.
  useEffect(() => { refresh() }, [refresh])

  // Background poll while the tab is focused. Pauses when the tab is
  // hidden (visibilitychange) so we don't waste cycles on inactive tabs.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer) return
      timer = setInterval(() => refresh(), POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null }
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        refresh()  // immediate refresh on return so the user sees current state
        start()
      } else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [refresh])

  return (
    <Ctx.Provider value={{ pendingCount, refresh, loading }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAccountsCount(): AccountsCountCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAccountsCount must be used inside AccountsCountProvider')
  return ctx
}

// Returns the set of ICP ids that belong to a portfolio company. Used to
// gate pending-pair counting so we never credit (company × foreign-ICP)
// classifications to a workspace. Soft-fails to null on network errors so
// the caller falls back to counting every classification (i.e. the old,
// less-accurate behavior) rather than blanking the pill entirely.
async function fetchWorkspaceIcpIds(portfolioCompany: string): Promise<Set<string> | null> {
  try {
    const r = await fetch(`${API_BASE}/api/icps?portfolioCompany=${encodeURIComponent(portfolioCompany)}`)
    if (!r.ok) return null
    const data = await r.json() as { icps?: Array<{ id: string }> }
    return new Set((data.icps || []).map((i) => i.id))
  } catch {
    return null
  }
}
