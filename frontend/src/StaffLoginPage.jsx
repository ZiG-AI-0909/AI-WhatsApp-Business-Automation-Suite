import { useEffect, useRef, useState } from 'react'
import BrandLogo from './components/BrandLogo.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import Icon from './components/Icon.jsx'
import { normalizeStaffCode } from './technician/technicianForm.js'
import { DASHBOARD_PATH, readStaffSession, saveStaffSession, staffFetch } from './staff/staffSession.js'

// ─────────────────────────────────────────────────────────────────────────────
// Staff & Member Login (/staff-login). Staff ID + PIN → a staff session
// (staff/staffSession.js) for the staff dashboard only; it is separate from
// the admin app's login and opens nothing there. The server checks the PIN,
// locks a Staff ID for 15 minutes after 5 wrong PINs and refuses inactive
// staff (routes/staffPortal.js). Mobile-first; partner-form page styles.
// ─────────────────────────────────────────────────────────────────────────────

export default function StaffLoginPage() {
  const [values, setValues] = useState({ staff_code: '', pin: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const codeRef = useRef(null)

  useEffect(() => {
    document.title = 'Staff & Member Login | Sudarshan Pipes'
    // Already signed in on this phone → straight to the dashboard.
    if (readStaffSession()) window.location.replace(DASHBOARD_PATH)
  }, [])

  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    const staffCode = normalizeStaffCode(values.staff_code)
    const pin = values.pin.trim()
    if (!staffCode || !pin) {
      setError(!staffCode ? 'Enter your Staff ID.' : 'Enter your PIN.')
      ;(staffCode ? document.getElementById('staff-login-pin') : codeRef.current)?.focus()
      return
    }
    setBusy(true)
    setError('')
    try {
      const session = await staffFetch('/login', { method: 'POST', body: { staff_code: staffCode, pin } })
      saveStaffSession(session)
      window.location.replace(DASHBOARD_PATH)
    } catch (err) {
      setError(err.message)
      setValues((current) => ({ ...current, pin: '' }))
      document.getElementById('staff-login-pin')?.focus()
      setBusy(false)
    }
  }

  return (
    <div className="kyc-page tech-page" lang="en">
      <header className="landing-header tech-header">
        <div className="landing-header-inner">
          <span className="landing-brand"><BrandLogo height={28} /></span>
          <span className="kyc-header-title">Staff &amp; Member Login</span>
          <ThemeToggle />
        </div>
      </header>

      <main className="kyc-main tech-main staff-login-main" id="main-content">
        <form className="panel staff-login" onSubmit={submit} noValidate aria-labelledby="staff-login-title">
          <span className="kyc-success-icon" aria-hidden="true"><Icon name="lock" size={32} /></span>
          <h1 id="staff-login-title">Staff &amp; Member Login</h1>
          <p className="muted-copy">Sign in with your Staff ID and PIN to see your registrations and your personal partner registration link.</p>

          <div className="kyc-field">
            <label className="kyc-label" htmlFor="staff-login-code">Staff ID</label>
            <input
              ref={codeRef}
              id="staff-login-code"
              value={values.staff_code}
              onChange={(event) => setValues({ ...values, staff_code: event.target.value.toUpperCase() })}
              type="text"
              maxLength={20}
              autoCapitalize="characters"
              autoComplete="username"
              spellCheck={false}
              placeholder="e.g. SEPL-TN001"
              aria-describedby={error ? 'staff-login-error' : undefined}
              autoFocus
            />
          </div>
          <div className="kyc-field">
            <label className="kyc-label" htmlFor="staff-login-pin">PIN</label>
            <input
              id="staff-login-pin"
              value={values.pin}
              onChange={(event) => setValues({ ...values, pin: event.target.value.replace(/\D/g, '') })}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              autoComplete="current-password"
              placeholder="4–8 digits"
              aria-describedby={error ? 'staff-login-error' : undefined}
            />
          </div>

          {error && <div id="staff-login-error" className="notice error" role="alert">{error}</div>}

          <button type="submit" className="primary-btn tech-submit" disabled={busy} aria-busy={busy}>
            {busy && <span className="tech-spinner" aria-hidden="true" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="field-help tech-secure"><Icon name="shield" size={14} /> Forgot your PIN? Ask the office to set a new one.</p>
        </form>
      </main>
      <footer className="page-footer">© {new Date().getFullYear()} <span lang="en">Sudarshan Extrusions Pvt. Ltd.</span> · Staff &amp; Member Login</footer>
    </div>
  )
}
