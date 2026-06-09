// useSweepEvents - Socket.IO subscription for live sweep progress.
//
// Connects to the BlueBird backend on first mount, joins the room for the
// supplied icpId, and surfaces a derived progress object the UI can render
// directly. Auto-resubscribes when icpId changes (e.g. user picks a
// different ICP) without tearing down the socket itself.
//
// Two pieces of state come back:
//
//   • `progress` - the most recent in-flight sweep state (cell + step +
//     companyIdx/total). This is what the "Now sweeping" panel reads to
//     show the current step + progress bar. Cleared when a `cell_complete`
//     event arrives, then repopulated on the next `cell_start`.
//
//   • `events` - the raw event stream, newest first, capped at 200 entries.
//     The activity log uses this directly. It includes both the granular
//     per-company events (scrape_start, classify_start) and the summary
//     ones (qualified, rejected, cell_complete) - the activity log filters
//     for the summary types so it doesn't flicker every few hundred ms.
//
// Cold load: the hook does NOT seed `events` from /api/grid/activity. The
// page that consumes it is responsible for that initial REST fetch (which
// it was already doing). The socket only carries new events from connect-
// time onward, which is exactly what the live progress panel needs.

import { useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { API_BASE } from '../lib/api-base'

// Verdict shape shared between the streamed events + the after-run response.
// Mirrors the backend's verdict object (api/routes/icps.js#/reclassify).
export interface ReclassifyVerdict {
  is_match: boolean
  reason: string
}

export interface SweepEvent {
  id: number
  ts: number
  type:
    | 'cell_start'
    | 'places_fetching'
    | 'places_fetched'
    | 'company_scrape_start'
    | 'company_classify_start'
    | 'company_qualified'
    | 'company_rejected'
    | 'cell_complete'
    // Reclassify-specific event types - the per-company "I'm running on
    // this now" pulse + non-fatal skip/error outcomes. Sweep events from
    // the live pipeline don't emit these, only reclassify does (cellId
    // will be 'reclassify' in that case).
    | 'company_scanning'
    | 'company_skipped'
    | 'company_error'
  icpId: string
  cellId?: string
  parentCity?: string | null
  domain?: string
  title?: string
  reason?: string
  state?: string
  companyIdx?: number
  totalCompanies?: number
  totalSurvivors?: number
  placesFound?: number
  qualifiedCount?: number
  // Reclassify diff payload - present on company_qualified / company_rejected
  // events fired from the reclassify path. The Reclassify tab uses these to
  // render the per-row old → new diff inline without a second fetch.
  oldVerdict?: ReclassifyVerdict | null
  newVerdict?: ReclassifyVerdict | null
  flipped?: boolean
  message: string
}

// Distilled "what's happening right now" state used by the Now-Sweeping
// panel. Recomputed on every event arrival; null when nothing's mid-sweep.
export interface SweepProgress {
  cellId: string
  parentCity: string | null
  // High-level stage label for the panel header. Distinct from the per-
  // company step so we can show e.g. "Sweeping London cell" up top with
  // "Scraping foo.co.uk (3/7)" below it.
  stage: 'fetching_places' | 'processing_companies'
  // Active step text - what's literally happening this second. e.g.
  // "Scraping premier-london-vehicle-hire.co.uk", "Classifying ...".
  stepLabel: string
  // For the progress bar. Both nullable when we're still in the "fetching
  // places" stage and don't know the total yet.
  companyIdx: number | null
  totalCompanies: number | null
  // Last event timestamp - handy for "stuck for a long time" indicators.
  lastUpdateAt: number
}

const MAX_EVENTS = 200

// Compute the current SweepProgress from a single incoming event. Returns
// null for `cell_complete` (the panel collapses), or for events that don't
// represent an in-flight state.
function progressFromEvent(evt: SweepEvent): SweepProgress | null {
  switch (evt.type) {
    case 'cell_start':
    case 'places_fetching':
      return {
        cellId: evt.cellId || '',
        parentCity: evt.parentCity || null,
        stage: 'fetching_places',
        stepLabel: evt.message || 'Fetching places',
        companyIdx: null,
        totalCompanies: null,
        lastUpdateAt: evt.ts,
      }
    case 'places_fetched':
      // This fires once between Maps and the per-company loop. We render
      // it as an informational pulse but stay in the fetching stage until
      // the first company event lands - feels less abrupt than snapping
      // straight from "fetching" to "scraping company 1" in one frame.
      return {
        cellId: evt.cellId || '',
        parentCity: evt.parentCity || null,
        stage: 'fetching_places',
        stepLabel: evt.message || `Found ${evt.totalSurvivors ?? '?'} places`,
        companyIdx: 0,
        totalCompanies: evt.totalSurvivors ?? null,
        lastUpdateAt: evt.ts,
      }
    case 'company_scrape_start':
    case 'company_classify_start':
      return {
        cellId: evt.cellId || '',
        parentCity: evt.parentCity || null,
        stage: 'processing_companies',
        stepLabel: evt.message,
        companyIdx: evt.companyIdx ?? null,
        totalCompanies: evt.totalCompanies ?? null,
        lastUpdateAt: evt.ts,
      }
    case 'company_qualified':
    case 'company_rejected':
      // Result events update the progress bar (idx advances) but the
      // step label can show "Classified X - qualified" briefly until the
      // next scrape kicks in. Keeps the panel from flashing empty between
      // companies.
      return {
        cellId: evt.cellId || '',
        parentCity: evt.parentCity || null,
        stage: 'processing_companies',
        stepLabel: evt.message,
        companyIdx: evt.companyIdx ?? null,
        totalCompanies: evt.totalCompanies ?? null,
        lastUpdateAt: evt.ts,
      }
    case 'cell_complete':
      // Cell is done - the panel should collapse. Returning null tells
      // the consumer to clear the in-flight state.
      return null
    default:
      return null
  }
}

export function useSweepEvents(icpId: string | null) {
  const [events, setEvents] = useState<SweepEvent[]>([])
  const [progress, setProgress] = useState<SweepProgress | null>(null)
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<Socket | null>(null)

  // Open the socket once on mount, regardless of icpId. The room
  // membership is what we change per icpId - the connection itself is
  // long-lived. Vite proxies /socket.io to the backend (see vite.config.ts).
  useEffect(() => {
    const s = io(API_BASE || '/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'], // try ws first, fall back if blocked
    })
    socketRef.current = s
    s.on('connect', () => setConnected(true))
    s.on('disconnect', () => setConnected(false))
    s.on('sweep_event', (evt: SweepEvent) => {
      // Ignore events for other ICPs - should never happen because of
      // room scoping, but defensive in case of subscribe-race conditions.
      // (We intentionally don't capture `icpId` from the outer closure
      // here; we read it from the latest props via the ref below.)
      const wantId = wantIcpRef.current
      if (wantId && evt.icpId !== wantId) return
      setEvents((prev) => {
        const next = [evt, ...prev]
        return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next
      })
      const p = progressFromEvent(evt)
      if (p === null && evt.type === 'cell_complete') {
        // Cell finished - clear the panel.
        setProgress(null)
      } else if (p) {
        setProgress(p)
      }
    })
    return () => {
      s.disconnect()
      socketRef.current = null
    }
    // Intentionally only on mount - icpId changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep a ref of the current icpId so the socket's `sweep_event` listener
  // (registered once on mount) can read fresh values without rebinding.
  const wantIcpRef = useRef<string | null>(icpId)
  useEffect(() => { wantIcpRef.current = icpId }, [icpId])

  // (Re)subscribe to the right room when icpId changes. The previous room
  // is left automatically by the server-side `subscribe` handler.
  useEffect(() => {
    const s = socketRef.current
    if (!s) return
    if (icpId) {
      s.emit('subscribe', icpId)
    } else {
      s.emit('unsubscribe')
    }
    // Clear stale per-ICP state - we don't want events from the previous
    // ICP polluting the new one's view.
    setEvents([])
    setProgress(null)
  }, [icpId])

  return { events, progress, connected }
}
