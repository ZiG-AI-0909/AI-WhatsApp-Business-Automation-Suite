import { useEffect, useRef, useState } from 'react'
import BrandLogo from './components/BrandLogo.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import Icon from './components/Icon.jsx'
import { API_URL } from './api.js'
import {
  EMPLOYEE_FIELD_ORDER, EMPLOYEE_INITIAL_VALUES, EMPLOYEE_STATES,
  registrationDetailsText, validateEmployeeField, validateEmployeeForm,
} from './technician/employeeForm.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public employee self-registration (#/employee-registration or
// /employee-registration) — no sign-in. Management shares the link from
// "Staff & targets" (TechnicianStaffView). The server allocates the Employee
// ID (SEPL-{STATE}{NNN}) and the initial PIN (last 4 digits of the mobile);
// this page shows them once, with copy and download buttons. Reuses the
// partner form's page styles (kyc-* / tech-* classes) plus emp-* in App.css.
// ─────────────────────────────────────────────────────────────────────────────

const SUBMIT_TIMEOUT_MS = 30_000

/** One id per fill-in: a retry after a lost response returns the same Employee ID. */
function newClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  const bytes = window.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const LABELS = {
  full_name: 'Full Name',
  mobile: 'Mobile Number',
  state: 'State of Operation',
  email: 'Email Address',
}
const REQUIRED = ['full_name', 'mobile', 'state']

function CopyButton({ text, label, onCopied }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      onCopied?.()
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt(`Copy your ${label}:`, text)
      onCopied?.()
    }
  }
  return (
    <button type="button" className="secondary-btn tech-big-btn" onClick={copy}>
      <Icon name={copied ? 'check-circle' : 'clipboard'} size={16} /> {copied ? 'Copied' : `Copy ${label}`}
    </button>
  )
}

function SuccessScreen({ result, onFinish }) {
  const [saved, setSaved] = useState(false)
  const { employee, pin } = result

  // Warn before closing the tab until the ID and PIN were copied or downloaded.
  useEffect(() => {
    if (saved) return undefined
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [saved])

  const download = () => {
    const blob = new Blob([registrationDetailsText(result)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${employee.employee_id}-registration.txt`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setSaved(true)
  }

  const finish = () => {
    if (!saved && !window.confirm('Have you saved your Employee ID and PIN? You will not be able to see the PIN again.')) return
    onFinish()
  }

  return (
    <section className="panel kyc-success emp-success" aria-live="polite">
      <span className="kyc-success-icon" aria-hidden="true"><Icon name="check-circle" size={40} /></span>
      <h1>Registration Successful!</h1>
      <p className="muted-copy">Welcome to Sudarshan Pipes, {employee.full_name}. Save your Employee ID and PIN now.</p>
      <dl className="emp-details">
        <div><dt>Employee Name</dt><dd>{employee.full_name}</dd></div>
        <div className="emp-key"><dt>Employee ID</dt><dd className="kyc-reference">{employee.employee_id}</dd></div>
        <div><dt>Registered State</dt><dd>{employee.state}</dd></div>
        <div><dt>Mobile Number</dt><dd>{employee.mobile_masked}</dd></div>
        <div className="emp-key"><dt>Initial PIN</dt><dd className="kyc-reference">{pin}</dd></div>
      </dl>
      <p className="field-help emp-pin-note"><Icon name="lock" size={14} /> Your initial PIN is the last 4 digits of your mobile number. Keep it private; you may be asked to change it later.</p>
      <div className="emp-actions">
        <CopyButton text={employee.employee_id} label="Employee ID" />
        <CopyButton text={pin} label="PIN" onCopied={() => setSaved(true)} />
        <button type="button" className="secondary-btn tech-big-btn" onClick={download}><Icon name="download" size={16} /> Download Registration Details</button>
        <button type="button" className="primary-btn tech-big-btn" onClick={finish}>Finish</button>
      </div>
    </section>
  )
}

export default function EmployeeRegistrationPage() {
  const [values, setValues] = useState(EMPLOYEE_INITIAL_VALUES)
  const [errors, setErrors] = useState({})
  const [attempted, setAttempted] = useState(false)
  const [notice, setNotice] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [finished, setFinished] = useState(false)
  const clientIdRef = useRef(null)
  const submittingRef = useRef(false)
  const noticeRef = useRef(null)

  useEffect(() => { document.title = 'Employee Registration · Sudarshan Pipes' }, [])

  const onChange = (name, value) => {
    const next = { ...values, [name]: value }
    setValues(next)
    // A different person or state is a different registration.
    if (name === 'mobile' || name === 'state') clientIdRef.current = null
    if (attempted || errors[name]) setErrors((current) => ({ ...current, [name]: validateEmployeeField(name, next) }))
  }
  const onBlur = (name) => {
    if (values[name] || attempted) setErrors((current) => ({ ...current, [name]: validateEmployeeField(name, values) }))
  }

  const focusFirstError = (fieldErrors) => {
    const first = EMPLOYEE_FIELD_ORDER.find((key) => fieldErrors[key])
    if (first) window.setTimeout(() => document.getElementById(`emp-${first}`)?.focus(), 0)
  }

  const submit = async (event) => {
    event.preventDefault()
    if (submittingRef.current) return
    setAttempted(true)
    setNotice(null)
    const fieldErrors = validateEmployeeForm(values)
    setErrors(fieldErrors)
    if (Object.keys(fieldErrors).length) {
      setNotice({ type: 'error', text: 'Please correct the highlighted fields.' })
      focusFirstError(fieldErrors)
      return
    }
    clientIdRef.current ||= newClientId()
    submittingRef.current = true
    setSubmitting(true)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
    try {
      const response = await fetch(`${API_URL}/public/employee-registration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, client_submission_id: clientIdRef.current }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.employee && data.pin) {
        setResult({ employee: data.employee, pin: data.pin })
        window.scrollTo(0, 0)
        return
      }
      if (response.status === 400 && data.fields) {
        setErrors(data.fields)
        focusFirstError(data.fields)
      }
      const text = response.status === 429 ? data.error || 'Too many attempts. Please try again later.'
        : response.status === 409 ? data.error
        : response.status >= 500 ? (data.code === 'TECH_MIGRATION_PENDING' ? 'Registration is not open yet. Please contact your manager.' : 'The server could not save your registration. Please try again in a moment.')
        : data.error || `Your registration could not be submitted (${response.status}).`
      setNotice({ type: 'error', text })
    } catch {
      // The request may still have been saved: a retry reuses the same client id.
      setNotice({ type: 'error', text: 'Could not reach the server. Check your internet connection and press Register again — you will not be registered twice.' })
    } finally {
      window.clearTimeout(timer)
      submittingRef.current = false
      setSubmitting(false)
      window.setTimeout(() => noticeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 0)
    }
  }

  const finish = () => {
    setResult(null)
    setValues(EMPLOYEE_INITIAL_VALUES)
    setErrors({})
    setAttempted(false)
    clientIdRef.current = null
    setFinished(true)
    window.scrollTo(0, 0)
  }

  const control = (name) => ({
    id: `emp-${name}`,
    name,
    value: values[name],
    onChange: (event) => onChange(name, event.target.value),
    onBlur: () => onBlur(name),
    'aria-invalid': errors[name] ? 'true' : undefined,
    'aria-describedby': errors[name] ? `emp-${name}-error` : undefined,
    'aria-required': REQUIRED.includes(name) ? 'true' : undefined,
  })
  const label = (name) => (
    <label className="kyc-label" htmlFor={`emp-${name}`}>
      {LABELS[name]}
      {REQUIRED.includes(name)
        ? <><span className="kyc-required" aria-hidden="true"> *</span><span className="visually-hidden"> (required)</span></>
        : <span className="muted-copy"> (optional)</span>}
    </label>
  )
  const error = (name) => errors[name] && <p id={`emp-${name}-error`} className="kyc-error" role="alert">{errors[name]}</p>

  return (
    <div className="kyc-page tech-page" lang="en">
      <header className="landing-header tech-header">
        <div className="landing-header-inner">
          <span className="landing-brand"><BrandLogo height={28} /></span>
          <span className="kyc-header-title">Employee Registration</span>
          <ThemeToggle />
        </div>
      </header>

      <main className="kyc-main tech-main" id="main-content">
        {result ? (
          <SuccessScreen result={result} onFinish={finish} />
        ) : finished ? (
          <section className="panel kyc-success" aria-live="polite">
            <span className="kyc-success-icon" aria-hidden="true"><Icon name="check-circle" size={40} /></span>
            <h1>You're all set</h1>
            <p className="muted-copy">Your registration is complete. You can close this page now.</p>
          </section>
        ) : (
          <form className="kyc-form" onSubmit={submit} noValidate>
            <section className="kyc-intro tech-intro">
              <p className="tech-company">
                <strong>Sudarshan Pipes (SEPL)</strong>
              </p>
              <h1>Employee Registration</h1>
              <p className="tech-subheading">Register to receive your Employee ID and PIN.</p>
              <p className="muted-copy">Fields marked * are required. Your State of Operation is the state where you will work with customers, dealers and partners.</p>
            </section>

            <section className="panel kyc-section" aria-labelledby="emp-section-main">
              <header className="kyc-section-head">
                <span className="kyc-section-number" aria-hidden="true"><Icon name="user" size={16} /></span>
                <div><h2 id="emp-section-main">Your details</h2></div>
              </header>
              <div className="kyc-grid">
                <div className="kyc-field is-wide">
                  {label('full_name')}
                  <input {...control('full_name')} type="text" maxLength={120} autoComplete="name" placeholder="As on your ID card" />
                  {error('full_name')}
                </div>
                <div className="kyc-field">
                  {label('mobile')}
                  <div className="tech-phone">
                    <span className="tech-phone-code" aria-label="Country code India">+91</span>
                    <input {...control('mobile')} type="tel" inputMode="numeric" maxLength={16} autoComplete="tel-national" placeholder="10-digit mobile number" />
                  </div>
                  <small className="field-help">Your initial PIN will be the last 4 digits of this number.</small>
                  {error('mobile')}
                </div>
                <div className="kyc-field">
                  {label('state')}
                  <select {...control('state')}>
                    <option value="">Select your state</option>
                    {EMPLOYEE_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
                  </select>
                  {error('state')}
                </div>
                <div className="kyc-field is-wide">
                  {label('email')}
                  <input {...control('email')} type="email" inputMode="email" maxLength={254} autoComplete="email" autoCapitalize="off" spellCheck={false} placeholder="name@example.com" />
                  {error('email')}
                </div>
              </div>
            </section>

            <div ref={noticeRef} className="kyc-submit-bar">
              {notice && <div className={`notice ${notice.type}`} role="alert">{notice.text}</div>}
              <button type="submit" className="primary-btn tech-submit" disabled={submitting} aria-busy={submitting}>
                {submitting && <span className="tech-spinner" aria-hidden="true" />}
                {submitting ? 'Registering…' : 'Register'}
              </button>
              <p className="field-help tech-secure"><Icon name="shield" size={14} /> Your details are sent securely and used only for your employment with Sudarshan Pipes.</p>
            </div>
          </form>
        )}
      </main>
      <footer className="page-footer">© {new Date().getFullYear()} Sudarshan Pipes</footer>
    </div>
  )
}
