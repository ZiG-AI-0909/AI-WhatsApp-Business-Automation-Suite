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

export async function apiFetch(path, options = {}) {
  // Attach the Supabase session JWT so the backend requireAuth middleware can verify it.
  let authHeader = {}

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
        authHeader = {
          Authorization: `Bearer ${session.access_token}`,
        }
      }
    } catch (error) {
      console.error('Failed to get Supabase session:', error)
    }
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...authHeader,
      ...(options.headers || {}),
    },
  })

  const data = await response.json().catch(() => ({}))

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
    throw error
  }

  return data
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
