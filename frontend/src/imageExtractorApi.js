// Shared fetch helpers for the Image Extractor page (both modes) —
// extracted from ImageExtractorView.jsx so the Identify Product tab
// reuses the exact same auth/request path.
const BACKEND_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')
export const API = `${BACKEND_URL}/api/image-extractor`

import { supabase } from './supabaseClient.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'

export { friendlyErrorMessage }

// Attach the Supabase session JWT the same way App.jsx's apiFetch does, so
// the backend requireAuth middleware can verify these requests. Without it
// every call returns 401 "Authentication required.".
export async function authHeaders() {
  if (!supabase) return {}
  try {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession()
    if (error) console.error('Supabase session error:', error)
    if (session?.access_token) {
      return { Authorization: `Bearer ${session.access_token}` }
    }
  } catch (error) {
    console.error('Failed to get Supabase session:', error)
  }
  return {}
}

export async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(await authHeaders()),
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  // A revalidated 304 is a success — the browser already has the cached
  // response body; don't fall into the !response.ok error path.
  if (response.status === 304) return data
  if (!response.ok) {
    // Keep the HTTP status so friendlyErrorMessage() can map 401/404/429/5xx
    // to human-readable text.
    const error = new Error(data.error || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }

  return data
}
