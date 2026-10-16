import { useEffect, useState } from 'react'

// Colour theme: 'dark' (default, "mission control") or 'light'.
// index.html sets <html data-theme> before the first paint; until the user
// picks a theme it follows the operating system (prefers-color-scheme).
// The user's choice is remembered in localStorage. Every storage access is
// wrapped in try/catch: private windows and blocked storage must not break
// the app — the theme then simply follows the system for that session.

export const THEME_STORAGE_KEY = 'sp-theme'
const THEME_CHANGED_EVENT = 'app:theme-changed'
const META_COLORS = { dark: '#060B18', light: '#F2F5FA' }

function storedTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function systemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', META_COLORS[theme])
}

export function setTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark'
  applyTheme(next)
  try { window.localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { theme: next } }))
}

/** [theme, toggleTheme] — re-renders when the theme changes anywhere. */
export function useTheme() {
  const [theme, setThemeState] = useState(currentTheme)
  useEffect(() => {
    const onChange = () => setThemeState(currentTheme())
    window.addEventListener(THEME_CHANGED_EVENT, onChange)
    let media = null
    const onSystemChange = () => {
      if (storedTheme()) return // the user's own choice wins
      applyTheme(systemTheme())
      setThemeState(currentTheme())
    }
    try {
      media = window.matchMedia('(prefers-color-scheme: light)')
      media.addEventListener('change', onSystemChange)
    } catch { /* matchMedia unavailable */ }
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, onChange)
      try { media?.removeEventListener('change', onSystemChange) } catch { /* ignore */ }
    }
  }, [])
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark')
  return [theme, toggleTheme]
}
