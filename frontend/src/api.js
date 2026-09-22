import { supabase } from './supabaseClient.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'

export const BACKEND_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')
// If the backend URL matches the current origin (e.g., when the app is hosted on Vercel together with the API), use a relative path to avoid cross‑origin requests.
export const API_URL = BACKEND_URL === window.location.origin ? '/api' : `${BACKEND_URL}/api`

// Local-session invalidation event. Fires when the backend rejects the JWT
// (401) or when auth-js reports a refresh failure — either way the stored
// session is dead and every authenticated call would keep 401-ing until the
// user signs out. Components listen for this to stop their polling instead
// of hammering the API (BUG 2: repeated 401 request loop after sign-out).
export const SESSION_INVALIDATED_EVENT = 'app:session-invalidated'
export function dispatchSessionInvalidated(reason) {
  console.warn(`[auth] session invalidated (${reason}) — notifying components to stop polling`)
  window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT, { detail: { reason } }))
}

async function authHeader() {
  if (supabase) {
    try {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession()

      if (error) {
        console.error('Supabase session error:', error)
        // getSession() only errors when it could not recover a usable session
        // (e.g. refresh rejected). The stored session is dead — see BUG 1.
        dispatchSessionInvalidated('getSession error')
      }

      if (session?.access_token) {
        return {
          Authorization: `Bearer ${session.access_token}`,
        }
      }
    } catch (error) {
      console.error('Failed to get Supabase session:', error)
    }
  }
  return {}
}

// Long-running AI endpoints get their own budget instead of hanging until
// the browser/server gives up. Server-side counterpart for '/boq/process' is
// ONE wall budget, BOQ_TOTAL_BUDGET_MS (default 150s, backend/src/routes/boq.js)
// that covers render + OCR + every AI chunk + retry. Keep the two values
// mirrored as one budget: client = server + ≥15s margin so the server's
// precise 504/502 always wins over the browser's generic abort. NOTE:
// scanned PDFs add an OCR phase (pdfjs render of every page + NVIDIA OCR in
// parallel batches, default cap 20 pages) on the SAME wall budget — the
// server answers inside this window with either the result or a precise
// retryable 504 rather than hanging; larger scans are rejected up front
// (413) before OCR starts.
const REQUEST_TIMEOUT_MS = 30000
const ENDPOINT_TIMEOUT_MS = {
  '/boq/process': 180000, // server wall budget is 150s (BOQ_TOTAL_BUDGET_MS) — covers parsing + page rendering + parallel OCR + every AI chunk + margin
}

function timeoutSignal(ms) {
  return (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(ms)
    : undefined // older browsers: no client timeout (same as before)
}

export async function apiFetch(path, options = {}) {
  // Attach the Supabase session JWT so the backend requireAuth middleware can verify it.
  const authHeaders = await authHeader()

  const budget = ENDPOINT_TIMEOUT_MS[path] || REQUEST_TIMEOUT_MS
  let response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: options.signal || timeoutSignal(budget),
      headers: {
        ...authHeaders,
        ...(options.headers || {}),
      },
    })
  } catch (fetchError) {
    // AbortSignal.timeout aborts produce a DOMException — convert to a
    // readable error so the UI says "timed out" instead of a raw
    // "signal is aborted without reason".
    if (fetchError?.name === 'TimeoutError' || fetchError?.name === 'AbortError') {
      const timeoutError = new Error(`Request timed out after ${Math.round(budget / 1000)}s. Try again or use a smaller file.`)
      timeoutError.status = 0
      throw timeoutError
    }
    throw fetchError
  }

  const data = await response.json().catch(() => ({}))

  // 304 carries no body and response.ok is false for it, yet the browser
  // already has the cached copy — a revalidated 304 is a success, not an
  // error (it used to surface as "Request failed (304) / trouble connecting").
  if (response.status === 304) return data

  if (!response.ok) {
    // 401 means the JWT we sent is expired/invalid and cannot be recovered
    // client-side. Clear the dead session from storage so auth-js stops
    // handing it out (it would otherwise be sent on every future call) and
    // tell components to stop polling. Mirrors the auth-js onAuthError path.
    if (response.status === 401 && supabase) {
      try { await supabase.auth._removeSession() } catch { /* best effort */ }
      dispatchSessionInvalidated(`API 401 on ${path}`)
    }
    // Attach the HTTP status so friendlyErrorMessage() can map 401/404/429/5xx
    // to human-readable text without pattern-matching strings.
    const error = new Error(data.error || `Request failed (${response.status})`)
    error.status = response.status
    // Long-running endpoints (BOQ extraction) attach a retry hint and the
    // failure stage so the UI can offer a Retry button instead of guessing.
    if (typeof data.retryable === 'boolean') error.retryable = data.retryable
    if (data.stage) error.stage = data.stage
    if (data.section != null) {
      error.section = data.section
      error.of = data.of
    }
    throw error
  }

  return data
}

// Same as apiFetch but returns the raw Response — for binary downloads
// (Excel/PDF exports) that must be read as a blob, not JSON.
export async function apiFetchRaw(path, options = {}) {
  const authHeaders = await authHeader()
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...authHeaders,
      ...(options.headers || {}),
    },
  })
}

export function socketAuth() {
  return (cb) => {
    if (!supabase) { console.warn('[socket] no Supabase client — connecting WITHOUT a token (server will reject the room join)'); return cb({}) }
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        // DEBUG: the server-side room join (realtime.js) uses this JWT. If the
        // token is missing here, the socket joins no room and every
        // whatsapp:qr emit goes to an empty room.
        console.log('[socket] auth callback — token:', session?.access_token ? 'present' : 'MISSING', '| user:', session?.user?.id || 'n/a')
        cb({ token: session?.access_token || null })
      })
      .catch((error) => { console.error('[socket] auth callback getSession failed:', error); cb({}) })
  }
}
