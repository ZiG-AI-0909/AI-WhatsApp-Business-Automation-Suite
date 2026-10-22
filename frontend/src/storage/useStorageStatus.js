import { useEffect, useState } from 'react'
import { io } from 'socket.io-client'
import { BACKEND_URL, apiFetch, socketAuth } from '../api.js'

// One shared storage status for the whole app (banner + dashboard card):
// fetched once, refreshed every 5 minutes and when the tab regains focus,
// and pushed in real time by the server's `storage:status` event.

const REFRESH_MS = 5 * 60_000
let state = { status: null, error: '', loading: true }
const listeners = new Set()
let started = false
let socket = null
let timer = null
let inflight = null

function emit(next) {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener(state))
}

export function refreshStorageStatus() {
  if (inflight) return inflight
  inflight = apiFetch('/storage/status')
    .then((status) => emit({ status, error: '', loading: false }))
    .catch((error) => emit({ error: error.message || 'Could not load storage status.', loading: false }))
    .finally(() => { inflight = null })
  return inflight
}

function start() {
  if (started) return
  started = true
  refreshStorageStatus()
  timer = window.setInterval(refreshStorageStatus, REFRESH_MS)
  window.addEventListener('focus', refreshStorageStatus)
  try {
    socket = io(BACKEND_URL, { transports: ['websocket', 'polling'], auth: socketAuth() })
    socket.on('storage:status', () => refreshStorageStatus())
  } catch { /* polling still works */ }
}

function stop() {
  started = false
  window.clearInterval(timer)
  window.removeEventListener('focus', refreshStorageStatus)
  socket?.disconnect()
  socket = null
  state = { status: null, error: '', loading: true }
}

/** { status, error, loading } — `status` is the /api/storage/status reply. */
export default function useStorageStatus(enabled = true) {
  const [value, setValue] = useState(state)
  useEffect(() => {
    if (!enabled) return undefined
    listeners.add(setValue)
    start()
    setValue(state)
    return () => {
      listeners.delete(setValue)
      if (!listeners.size) stop()
    }
  }, [enabled])
  return value
}
