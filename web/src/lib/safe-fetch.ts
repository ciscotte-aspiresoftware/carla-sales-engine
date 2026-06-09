// Cold-start-safe fetch helper.
//
// Render's free instance spins down after ~15 min idle. The first request
// after spindown returns an empty body while the service is waking up, which
// turns into "Unexpected end of JSON input" inside any `r.json()` call. This
// wrapper silently retries once after a short wait so users don't see the
// error - they just see a slightly slower first click.
//
// Used by:
//   • lib/api.ts postJson / getJson wrappers (covers most pages automatically)
//   • Page-level direct fetches (Coverage's action handlers, etc.) when they
//     don't go through the wrappers
//
// Heuristic-based: any error message that looks like a cold-start symptom
// (empty body, JSON parse, "Failed to fetch") triggers the retry. Real
// non-cold-start errors propagate so genuine outages aren't silently hidden.

const COLD_START_PATTERNS = ['JSON', 'empty', 'Unexpected', 'Failed to fetch'] as const

function looksLikeColdStart(message: string): boolean {
  return COLD_START_PATTERNS.some((p) => message.includes(p))
}

/**
 * Fetch a JSON response with automatic cold-start retry.
 *
 * Returns the parsed JSON body. Throws if both the initial attempt and the
 * retry fail (the second error is the one surfaced).
 *
 * Use this in place of `fetch(url, init).then(r => r.json())`.
 */
export async function safeFetchJson<T = any>(url: string, init?: RequestInit, retryAfterMs = 4000): Promise<T> {
  const attempt = async () => {
    const res = await fetch(url, init)
    const text = await res.text()
    if (!text || !text.trim()) throw new Error('empty response')
    try {
      return JSON.parse(text) as T
    } catch (e: any) {
      // Preserve HTTP status info if we can - useful for diagnostics.
      throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
  }
  try {
    return await attempt()
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (looksLikeColdStart(msg)) {
      await new Promise((r) => setTimeout(r, retryAfterMs))
      return attempt()
    }
    throw e
  }
}

/**
 * Lower-level variant: returns the raw Response object after one retry. Use
 * this when you need to read headers, status, or non-JSON bodies. Most
 * callers should prefer `safeFetchJson`.
 */
export async function safeFetch(url: string, init?: RequestInit, retryAfterMs = 4000): Promise<Response> {
  const attempt = () => fetch(url, init)
  try {
    const res = await attempt()
    // Empty 502/503 from Render's edge during cold start - retry.
    if (res.status >= 502 && res.status <= 504) {
      const cloned = res.clone()
      const text = await cloned.text()
      if (!text.trim()) {
        await new Promise((r) => setTimeout(r, retryAfterMs))
        return attempt()
      }
    }
    return res
  } catch (e: any) {
    if (looksLikeColdStart(String(e?.message || ''))) {
      await new Promise((r) => setTimeout(r, retryAfterMs))
      return attempt()
    }
    throw e
  }
}