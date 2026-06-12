import { useCallback, useRef, useState } from 'react'
import { enrichLeadPhone, type Lead } from '@/lib/api'
import { API_BASE } from '@/lib/api-base'
import { addToast } from '@/components/ui/toast'

// Shared async phone-reveal logic for any page that shows leads (Accounts,
// People, Sales Agent). Apollo's waterfall is async: /enrich-phone returns
// immediately with waterfall_pending, then Apollo POSTs the cell to our webhook
// a few minutes later. This hook initiates the reveal, polls /api/leads until
// the webhook answers (phoneCheckedAt advances — set on ANY outcome, a number
// or a definitive "no mobile"), then hands the updated lead back to the caller.
//
// The backend de-dupes/guards credits (already-revealed + in-flight), so the UI
// only needs to: keep a spinner up during the wait, surface the result, and
// splice the lead. Keyed by `${companyId}:${apolloId}` so multiple reveals can
// run at once across cards.
//
// NOTE: the poll fetches the company's full lead set and finds by apolloId —
// it must NOT pass the apolloId as ?search, because the /api/leads search
// filter matches name/title/email/company only, never apolloId.

const POLL_MS = 5000
const MAX_ATTEMPTS = 60 // ~5 minutes

function keyFor(companyId: string, apolloId: string) {
  return `${companyId}:${apolloId}`
}

export function usePhoneReveal() {
  const [revealing, setRevealing] = useState<Set<string>>(new Set())
  const [empty, setEmpty] = useState<Record<string, true>>({})
  const [error, setError] = useState<Record<string, string>>({})
  const timers = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  const stop = useCallback((key: string) => {
    setRevealing((prev) => { const n = new Set(prev); n.delete(key); return n })
  }, [])

  // Initiate a reveal. onResolved is called with the updated lead once Apollo's
  // webhook answers (whether or not a phone was found) so the caller can splice
  // it into its own state.
  const reveal = useCallback(
    async (
      companyId: string,
      apolloId: string,
      currentPhone: string | null | undefined,
      onResolved?: (lead: Lead) => void,
    ) => {
      if (!companyId || !apolloId) return
      const key = keyFor(companyId, apolloId)
      if (timers.current[key]) return // already in flight on this client
      setRevealing((prev) => { const n = new Set(prev); n.add(key); return n })
      setEmpty((prev) => { const { [key]: _drop, ...rest } = prev; return rest })
      setError((prev) => { const { [key]: _drop, ...rest } = prev; return rest })

      try {
        const res = await enrichLeadPhone(companyId, apolloId)
        if (res.waterfall_pending) {
          addToast('📱 Phone reveal in progress', 'info', 5000)
          let attempts = 0
          const poll = setInterval(async () => {
            attempts++
            if (attempts > MAX_ATTEMPTS) {
              clearInterval(poll); delete timers.current[key]
              stop(key)
              addToast('⏱ Phone reveal timed out — try again later', 'info', 5000)
              return
            }
            try {
              const updated: Lead | undefined = await fetch(`${API_BASE}/api/leads?companyId=${encodeURIComponent(companyId)}`)
                .then((r) => r.json())
                .then((r) => (r.leads || []).find((l: any) => l.apolloId === apolloId))
              if (updated?.phoneCheckedAt) {
                clearInterval(poll); delete timers.current[key]
                const gotNew = !!updated.phone && updated.phone !== currentPhone
                if (gotNew) addToast('✅ Cell revealed', 'success', 4000)
                else { addToast('📵 No mobile on file', 'info', 4000); setEmpty((prev) => ({ ...prev, [key]: true })) }
                onResolved?.(updated)
                stop(key)
              }
            } catch { /* ignore poll errors, keep trying */ }
          }, POLL_MS)
          timers.current[key] = poll
        } else {
          // Synchronous answer: already revealed earlier, or nothing to reveal.
          if (res.lead) onResolved?.(res.lead)
          if (!res.lead?.phone && res.phoneFound === false) setEmpty((prev) => ({ ...prev, [key]: true }))
          stop(key)
        }
      } catch (err: any) {
        setError((prev) => ({ ...prev, [key]: err?.message || 'Phone reveal failed' }))
        stop(key)
      }
    },
    [stop],
  )

  const isRevealing = useCallback((companyId: string, apolloId: string) => revealing.has(keyFor(companyId, apolloId)), [revealing])
  const isEmpty = useCallback((companyId: string, apolloId: string) => !!empty[keyFor(companyId, apolloId)], [empty])
  const errorFor = useCallback((companyId: string, apolloId: string) => error[keyFor(companyId, apolloId)] || null, [error])

  return { reveal, isRevealing, isEmpty, errorFor }
}
