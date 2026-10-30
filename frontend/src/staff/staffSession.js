// Staff & Member Login session (StaffLoginPage / StaffDashboardPage).
// The token comes from POST /api/staff-portal/login: a 12-hour session for
// one staff member, separate from the admin app's Supabase sign-in (it
// opens nothing in the admin app). Kept in localStorage so it survives the
// phone closing the tab; it expires on the server whatever is stored here.

import { API_URL } from '../api.js'

const STORAGE_KEY = 'sp-staff-session'
export const LOGIN_PATH = '/staff-login'
export const DASHBOARD_PATH = '/staff/dashboard'

/** { token, expires_at, staff } or null (none, expired or unreadable). */
export function readStaffSession() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
    if (!saved?.token || !(Date.parse(saved.expires_at) > Date.now())) return null
    return saved
  } catch {
    return null
  }
}

export function saveStaffSession(session) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session)) } catch { /* private mode: this tab only */ }
}

export function clearStaffSession() {
  try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* nothing stored */ }
}

export class StaffApiError extends Error {
  constructor(message, status, data = {}) {
    super(message)
    this.status = status
    this.code = data.code
    this.fields = data.fields || {}
  }
}

/**
 * JSON request to /api/staff-portal with the session token. A 401 means
 * the session ended (expired, PIN changed, deactivated): it is cleared and
 * the caller sends the person back to the login page.
 */
export async function staffFetch(path, { method = 'GET', body } = {}) {
  const session = readStaffSession()
  const headers = { Accept: 'application/json' }
  if (session) headers.Authorization = `Bearer ${session.token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(`${API_URL}/staff-portal${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new StaffApiError('No internet connection. Check your connection and try again.', 0)
  }
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && path !== '/login') clearStaffSession()
  if (!response.ok) throw new StaffApiError(data.error || `Something went wrong (${response.status}). Please try again.`, response.status, data)
  return data
}
