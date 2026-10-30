import { useEffect, useMemo, useRef, useState } from 'react'
import BrandLogo from './components/BrandLogo.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import Icon from './components/Icon.jsx'
import { API_URL } from './api.js'
import { supabase } from './supabaseClient.js'
import { readStaffSession } from './staff/staffSession.js'
import { formatBytes, todayInIndia } from './kyc/kycForm.js'
import {
  DISTRICTS, DOCUMENT_ACCEPT, FIELD_ORDER, INITIAL_VALUES, REQUIRED, STATES,
  formatDmy, mapsLink, normalizeStaffCode, shrinkImage, validateDocument, validateField, validateForm, validateStaffLogin,
} from './technician/technicianForm.js'
import { DEFAULT_LANGUAGE, LANGUAGES, translator } from './technician/i18n.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public mechanic / technician partner registration
// (#/technician-registration or /technician-registration) — no sign-in.
// Mobile-first; Tamil by default, English on request (technician/i18n.js);
// switching language keeps everything typed. Staff review submissions under
// "Submitted forms" (TechnicianSubmissions). Uses the vendor KYC form's page
// styles (kyc-* classes) plus tech-* additions in App.css.
//
// Two modes: the partner registers themselves (default, 'self'), or a field
// staff member registers them ('staff') with their Staff ID + PIN — or,
// when signed in to the app with a linked account, automatically. The
// server checks the staff member on every submit; switching mode always
// clears the staff identity, so a registration is never credited to the
// wrong person.
// ─────────────────────────────────────────────────────────────────────────────

const LANG_STORAGE_KEY = 'sp-partner-form-lang'
// Generous for a 5 MB upload on a slow mobile connection. A timed-out
// request may still have been saved, so a retry reuses the same clientId.
const SUBMIT_TIMEOUT_MS = 120_000

function readLang() {
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY)
    return LANGUAGES.some((option) => option.code === saved) ? saved : DEFAULT_LANGUAGE
  } catch {
    return DEFAULT_LANGUAGE
  }
}

/** One id per fill-in: lets the server spot a retry of a request that already saved. */
function newClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  const bytes = window.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function LanguageSwitcher({ lang, onChange, t }) {
  return (
    <div className="tech-lang" role="group" aria-label={t('language')}>
      {LANGUAGES.map((option) => (
        <button
          key={option.code}
          type="button"
          lang={option.code}
          className={`tech-lang-btn${lang === option.code ? ' is-active' : ''}`}
          aria-pressed={lang === option.code}
          onClick={() => onChange(option.code)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const NO_LOCATION = { status: 'idle', lat: null, lng: null, accuracy: null }
const NO_STAFF_INPUT = { staff_code: '', staff_pin: '' }
const STAFF_FIELDS = ['staff_code', 'staff_pin']

/** A query parameter of the page URL (?ref=, ?mode=). */
function readParam(name) {
  try { return new URLSearchParams(window.location.search).get(name) || '' } catch { return '' }
}

/** Access token of a signed-in app user on this browser, or null. */
async function appAccessToken() {
  if (!supabase) return null
  try {
    const { data } = await supabase.auth.getSession()
    return data?.session?.access_token || null
  } catch {
    return null
  }
}

function ModeSwitch({ mode, onChange, t }) {
  const options = [
    { value: 'self', icon: 'user', label: t('modeSelf'), hint: t('modeSelfHint') },
    { value: 'staff', icon: 'users', label: t('modeStaff'), hint: t('modeStaffHint') },
  ]
  return (
    <section className="panel tech-mode" aria-labelledby="tech-mode-label">
      <p className="kyc-label" id="tech-mode-label">{t('modeQuestion')}</p>
      <div className="tech-mode-options" role="radiogroup" aria-labelledby="tech-mode-label">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            className={`tech-mode-btn${mode === option.value ? ' is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <Icon name={mode === option.value ? 'check-circle' : option.icon} size={22} />
            <span><strong>{option.label}</strong><small>{option.hint}</small></span>
          </button>
        ))}
      </div>
    </section>
  )
}

export default function TechnicianRegistrationPage() {
  const [lang, setLang] = useState(readLang)
  const t = useMemo(() => translator(lang), [lang])
  const [values, setValues] = useState(INITIAL_VALUES)
  const [file, setFile] = useState(null)
  const [preparingFile, setPreparingFile] = useState(false)
  const [location, setLocation] = useState(NO_LOCATION)
  const [errors, setErrors] = useState({})
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [result, setResult] = useState(null)
  // ?mode=staff opens Staff mode ("Fill form for a mechanic" on the staff dashboard).
  const [mode, setMode] = useState(() => (readParam('mode') === 'staff' ? 'staff' : 'self'))
  const [referrer, setReferrer] = useState(null) // { staff_code, full_name } of an active ?ref= staff member
  const [staffInput, setStaffInput] = useState(NO_STAFF_INPUT)
  const [staff, setStaff] = useState(null) // { staff_code, full_name, via: 'pin' | 'account' } once checked
  const [staffChecking, setStaffChecking] = useState('') // '' | 'account' | 'pin'
  const staffRunRef = useRef(0) // bumped on every mode/staff change, so late answers are dropped
  const submittingRef = useRef(false)
  const clientIdRef = useRef(null)
  const noticeRef = useRef(null)
  const today = todayInIndia()
  const hasDeviceLocation = location.status === 'captured'
  const dirty = !result && (Boolean(file) || hasDeviceLocation || Object.values(values).some(Boolean))

  useEffect(() => {
    document.title = t('pageTitle')
    // Lets Android/iOS pick Tamil fonts and the right screen-reader voice.
    const previous = document.documentElement.lang
    document.documentElement.lang = lang
    return () => { document.documentElement.lang = previous }
  }, [t, lang])

  const changeLang = (next) => {
    setLang(next)
    try { window.localStorage.setItem(LANG_STORAGE_KEY, next) } catch { /* private mode */ }
  }

  // Warn before leaving with a half-filled form.
  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const setFieldError = (key, code) => setErrors((current) => {
    if ((current[key] || '') === code) return current
    const next = { ...current }
    if (code) next[key] = code
    else delete next[key]
    return next
  })

  // Errors for the pasted Maps link show under the shop_location block.
  const errorKey = (name) => (name === 'shop_maps_url' ? 'shop_location' : name)
  const onChange = (name, value) => {
    const next = { ...values, [name]: value }
    setValues(next)
    // Once a field shows an error, re-check it as it is fixed.
    if (errors[errorKey(name)]) setFieldError(errorKey(name), validateField(name, next))
    if (name === 'date_of_birth' && (errors.date_of_marriage || next.date_of_marriage)) setFieldError('date_of_marriage', validateField('date_of_marriage', next))
  }
  const onBlur = (name) => {
    if (attempted || String(values[name] ?? '').trim()) setFieldError(errorKey(name), validateField(name, values))
  }

  // ── Mode + staff identity ─────────────────────────────────────────────
  const clearStaff = () => {
    staffRunRef.current += 1
    setStaff(null)
    setStaffInput(NO_STAFF_INPUT)
    setStaffChecking('')
    setErrors((current) => {
      if (!STAFF_FIELDS.some((key) => current[key])) return current
      const next = { ...current }
      STAFF_FIELDS.forEach((key) => delete next[key])
      return next
    })
    // Someone else (or nobody) is submitting now: never reuse the id.
    clientIdRef.current = null
  }

  const verifyRequest = (body, token) => fetch(`${API_URL}/public/technician/staff/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

  // Signed in at Staff & Member Login, or to the app with an account linked
  // to a Staff ID → no PIN needed.
  const checkAccount = async () => {
    const run = staffRunRef.current
    const staffSession = readStaffSession()?.token
    const token = staffSession ? null : await appAccessToken()
    if ((!staffSession && !token) || run !== staffRunRef.current) return
    setStaffChecking('account')
    try {
      const response = await verifyRequest(staffSession ? { staff_session: staffSession } : {}, token)
      const data = await response.json().catch(() => ({}))
      if (run !== staffRunRef.current) return
      if (data.staff) setStaff(data.staff)
      else if (data.fields) setErrors((current) => ({ ...current, ...data.fields }))
    } catch {
      // Not recognised: the Staff ID + PIN fields stay.
    } finally {
      if (run === staffRunRef.current) setStaffChecking('')
    }
  }

  // On load: who referred this partner (?ref=), and the staff member behind
  // ?mode=staff. An unknown or inactive ref shows nothing; the form still works.
  useEffect(() => {
    const ref = readParam('ref').trim().slice(0, 40)
    if (ref) {
      fetch(`${API_URL}/public/technician/ref/${encodeURIComponent(ref)}`)
        .then((response) => response.json())
        .then((data) => { if (data?.staff) setReferrer(data.staff) })
        .catch(() => {})
    }
    if (mode === 'staff') checkAccount()
  }, []) // once, on load

  const changeMode = (next) => {
    if (next === mode) return
    clearStaff()
    setMode(next)
    setNotice(null)
    if (next === 'staff') checkAccount()
  }

  const changeStaff = () => {
    clearStaff()
    window.setTimeout(() => document.getElementById('tech-staff_code')?.focus(), 0)
  }

  const onStaffInput = (name, value) => {
    setStaffInput((current) => ({ ...current, [name]: value }))
    if (errors[name]) setFieldError(name, '')
  }

  const verifyStaff = async () => {
    const found = validateStaffLogin(staffInput)
    if (Object.keys(found).length) {
      setErrors((current) => ({ ...current, ...found }))
      return
    }
    const run = staffRunRef.current
    setStaffChecking('pin')
    try {
      const response = await verifyRequest({ staff_code: normalizeStaffCode(staffInput.staff_code), staff_pin: staffInput.staff_pin.trim() })
      const data = await response.json().catch(() => ({}))
      if (run !== staffRunRef.current) return
      if (response.ok && data.staff) {
        setStaff(data.staff)
        STAFF_FIELDS.forEach((key) => setFieldError(key, ''))
      } else if (data.fields) {
        setErrors((current) => ({ ...current, ...data.fields }))
      } else {
        setFieldError('staff_pin', response.status === 429 ? 'staff_locked' : 'staff_check_failed')
      }
    } catch {
      if (run === staffRunRef.current) setFieldError('staff_pin', 'staff_check_failed')
    } finally {
      if (run === staffRunRef.current) setStaffChecking('')
    }
  }

  // ── Shop location: asked for only when the button is tapped, once ──────
  const shareLocation = () => {
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocation({ ...NO_LOCATION, status: 'unsupported' })
      return
    }
    setLocation({ ...NO_LOCATION, status: 'locating' })
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Math.round(position.coords.latitude * 1e6) / 1e6
        const lng = Math.round(position.coords.longitude * 1e6) / 1e6
        setLocation({ status: 'captured', lat, lng, accuracy: Math.round(position.coords.accuracy) })
        setFieldError('shop_location', '')
      },
      (error) => setLocation({ ...NO_LOCATION, status: error.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    )
  }
  const removeLocation = () => setLocation(NO_LOCATION)

  const chooseFile = async (picked) => {
    if (!picked) {
      setFile(null)
      setFieldError('aadhaar', '')
      return
    }
    setPreparingFile(true)
    const ready = await shrinkImage(picked)
    setPreparingFile(false)
    setFile(ready)
    setFieldError('aadhaar', validateDocument(ready))
  }

  const focusFirst = (found) => {
    const first = [...STAFF_FIELDS, ...FIELD_ORDER].find((key) => found[key])
    const element = first && (document.getElementById(`tech-${first}`) || document.getElementById(first === 'shop_location' ? 'tech-shop_maps_url' : ''))
    if (element) {
      element.focus({ preventScroll: true })
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    if (submittingRef.current || preparingFile) return // no duplicate submissions
    setAttempted(true)
    const found = validateForm(values, { aadhaar: file }, { hasDeviceLocation })
    if (mode === 'staff' && !staff) Object.assign(found, validateStaffLogin(staffInput))
    setErrors(found)
    if (Object.keys(found).length) {
      setNotice({ type: 'error', key: 'fixErrors', vars: { count: Object.keys(found).length } })
      focusFirst(found)
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    setNotice(null)
    clientIdRef.current ||= newClientId()
    const form = new FormData()
    form.append('client_submission_id', clientIdRef.current)
    for (const key of Object.keys(INITIAL_VALUES)) {
      if (key === 'shop_maps_url' && hasDeviceLocation) continue
      form.append(key, values[key] ?? '')
    }
    if (hasDeviceLocation) {
      form.append('shop_latitude', String(location.lat))
      form.append('shop_longitude', String(location.lng))
      form.append('shop_location_accuracy', String(location.accuracy ?? ''))
    }
    if (file) form.append('aadhaar', file)
    // Staff fields only in Staff mode; the server ignores them otherwise.
    const headers = {}
    if (mode === 'staff') {
      form.append('registration_source', 'staff')
      if (staff?.via === 'session') {
        form.append('staff_session', readStaffSession()?.token || '')
      } else if (staff?.via === 'account') {
        const token = await appAccessToken()
        if (token) headers.Authorization = `Bearer ${token}`
      } else {
        form.append('staff_code', normalizeStaffCode(staff?.staff_code || staffInput.staff_code))
        form.append('staff_pin', staffInput.staff_pin.trim())
      }
    } else if (referrer) {
      // Personal link: the server checks the code again and credits that staff member.
      form.append('ref_code', referrer.staff_code)
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
    try {
      const response = await fetch(`${API_URL}/public/technician${mode === 'staff' ? '?staff=1' : ''}`, { method: 'POST', body: form, headers, signal: controller.signal })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const fields = data.fields && typeof data.fields === 'object' ? data.fields : {}
        if (Object.keys(fields).length) {
          // Staff ID / PIN refused (e.g. deactivated meanwhile): ask for it again.
          if (STAFF_FIELDS.some((key) => fields[key])) setStaff(null)
          setErrors(fields)
          setNotice({ type: 'error', key: 'fixErrors', vars: { count: Object.keys(fields).length } })
          focusFirst(fields)
        } else {
          const key = response.status === 429 ? 'rateLimited' : response.status === 502 ? 'uploadError' : 'serverError'
          setNotice({ type: 'error', key })
          noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        return
      }
      setResult(data)
      window.scrollTo(0, 0)
    } catch (error) {
      setNotice({ type: 'error', key: error?.name === 'AbortError' ? 'timeoutError' : 'networkError' })
      noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } finally {
      window.clearTimeout(timer)
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  // Staff mode stays on with the same checked staff member (their name stays
  // on screen), so they can register the next partner straight away.
  const reset = () => {
    setValues(INITIAL_VALUES)
    setFile(null)
    setLocation(NO_LOCATION)
    setErrors({})
    setAttempted(false)
    setNotice(null)
    setResult(null)
    clientIdRef.current = null
    window.scrollTo(0, 0)
  }

  // Shared props for every control; error text is shown in the current language.
  const control = (name) => {
    const key = errorKey(name)
    return {
      id: `tech-${name}`,
      name,
      value: values[name],
      onChange: (event) => onChange(name, event.target.value),
      onBlur: () => onBlur(name),
      'aria-invalid': errors[key] ? 'true' : undefined,
      'aria-describedby': errors[key] ? `tech-${key}-error` : undefined,
      'aria-required': REQUIRED.includes(name) ? 'true' : undefined,
    }
  }
  const label = (name) => (
    <label className="kyc-label" htmlFor={`tech-${name}`}>
      {t(name)}
      {REQUIRED.includes(name) && <><span className="kyc-required" aria-hidden="true"> *</span><span className="visually-hidden"> ({t('required')})</span></>}
    </label>
  )
  const error = (name) => errors[name] && <p id={`tech-${name}-error`} className="kyc-error" role="alert">{t.error(errors[name], name)}</p>
  const dateHint = (name) => values[name] && !errors[name] && <small className="field-help">{t('selectedDate', { date: formatDmy(values[name]) })}</small>
  const textField = (name, props = {}) => (
    <div className={`kyc-field${props.wide ? ' is-wide' : ''}`}>
      {label(name)}
      <input {...control(name)} type="text" maxLength={120} placeholder={t(`${name}Placeholder`)} {...props.input} />
      {error(name)}
    </div>
  )

  const locationMessage = { denied: 'locationDenied', unavailable: 'locationUnavailable', unsupported: 'locationUnsupported' }[location.status]

  return (
    <div className="kyc-page tech-page" lang={lang}>
      <header className="landing-header tech-header">
        <div className="landing-header-inner">
          <span className="landing-brand"><BrandLogo height={28} /></span>
          <span className="kyc-header-title">{t('headerTitle')}</span>
          <LanguageSwitcher lang={lang} onChange={changeLang} t={t} />
          <ThemeToggle />
        </div>
      </header>

      <main className="kyc-main tech-main" id="main-content">
        {result ? (
          <section className="panel kyc-success" aria-live="polite">
            <span className="kyc-success-icon" aria-hidden="true"><Icon name="check-circle" size={40} /></span>
            <h1>{t('successTitle')}</h1>
            <p>{t('successRef')}</p>
            <p className="kyc-reference">{result.reference}</p>
            <p className="muted-copy">{t('successBody', { mobile: `+91 ${values.mobile.replace(/\D/g, '').slice(-10)}` })}</p>
            {result.referred_by && (
              <p className="tech-staff-credit"><Icon name="user" size={16} /> {t('referredBy', { name: result.referred_by.full_name })}</p>
            )}
            {result.registered_by && (
              <p className="tech-staff-credit"><Icon name="user" size={16} /> {t('successStaff', { name: result.registered_by.full_name, code: result.registered_by.staff_code })}</p>
            )}
            <div className="button-row"><button type="button" className="secondary-btn tech-big-btn" onClick={reset}>{t('registerAnother')}</button></div>
          </section>
        ) : (
          <form className="kyc-form" onSubmit={submit} noValidate>
            <section className="kyc-intro tech-intro">
              <p className="tech-company">
                <strong lang="en">{t('companyName')}</strong>
                <span lang="en">{t('tagline')}</span>
              </p>
              <h1>{t('heading')}</h1>
              <p className="tech-subheading">{t('subheading')}</p>
              <p className="muted-copy">{t('requiredNote')}</p>
            </section>

            <ModeSwitch mode={mode} onChange={changeMode} t={t} />

            {/* Personal link of a staff member (?ref=), shown only when they are active */}
            {mode === 'self' && referrer && (
              <p className="notice info tech-referrer" role="status"><Icon name="user" size={16} /> {t('referredBy', { name: referrer.full_name })}</p>
            )}

            {/* Staff mode only: who is registering this partner */}
            {mode === 'staff' && (
              <section className="panel kyc-section tech-staff" aria-labelledby="tech-section-staff">
                <header className="kyc-section-head">
                  <span className="kyc-section-number" aria-hidden="true"><Icon name="user" size={16} /></span>
                  <div>
                    <h2 id="tech-section-staff">{t('staffSection')}</h2>
                    {!staff && <p className="muted-copy">{t('staffSectionNote')}</p>}
                  </div>
                </header>
                {staff ? (
                  <div className="tech-location-card" role="status">
                    <p className="tech-location-ok"><Icon name="check-circle" size={18} /> {t('staffVerified', { name: staff.full_name, code: staff.staff_code })}</p>
                    <small className="field-help">{t({ account: 'staffViaAccount', session: 'staffViaSession' }[staff.via] || 'staffViaPin')}</small>
                    <div><button type="button" className="ghost-btn tech-big-btn" onClick={changeStaff}>{t('changeStaff')}</button></div>
                  </div>
                ) : staffChecking === 'account' ? (
                  <p className="field-help" role="status"><span className="tech-spinner" aria-hidden="true" /> {t('checkingAccount')}</p>
                ) : (
                  <div className="kyc-grid">
                    {STAFF_FIELDS.map((name) => (
                      <div className="kyc-field" key={name}>
                        <label className="kyc-label" htmlFor={`tech-${name}`}>
                          {t(name)}<span className="kyc-required" aria-hidden="true"> *</span><span className="visually-hidden"> ({t('required')})</span>
                        </label>
                        <input
                          id={`tech-${name}`}
                          name={name}
                          value={staffInput[name]}
                          onChange={(event) => onStaffInput(name, event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); verifyStaff() } }}
                          aria-invalid={errors[name] ? 'true' : undefined}
                          aria-describedby={errors[name] ? `tech-${name}-error` : undefined}
                          aria-required="true"
                          placeholder={t(`${name}Placeholder`)}
                          lang="en"
                          {...(name === 'staff_pin'
                            ? { type: 'password', inputMode: 'numeric', maxLength: 8, autoComplete: 'off' }
                            : { type: 'text', maxLength: 20, autoCapitalize: 'characters', autoComplete: 'off', spellCheck: false })}
                        />
                        {error(name)}
                      </div>
                    ))}
                    <div className="kyc-field is-wide">
                      <button type="button" className="secondary-btn tech-big-btn" onClick={verifyStaff} disabled={Boolean(staffChecking)} aria-busy={staffChecking === 'pin'}>
                        {staffChecking === 'pin' ? <span className="tech-spinner" aria-hidden="true" /> : <Icon name="shield" size={16} />}
                        {staffChecking === 'pin' ? t('verifyingStaff') : t('verifyStaff')}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Section 1 — fields 1–8 (all required except Shop Name) */}
            <section className="panel kyc-section" aria-labelledby="tech-section-main">
              <header className="kyc-section-head">
                <span className="kyc-section-number" aria-hidden="true">1</span>
                <div><h2 id="tech-section-main">{t(mode === 'staff' ? 'sectionMainStaff' : 'sectionMain')}</h2></div>
              </header>
              <div className="kyc-grid">
                {textField('full_name', { input: { autoComplete: 'name' } })}
                <div className="kyc-field">
                  {label('district')}
                  {/* Always the 38 Tamil Nadu districts, whichever state is chosen. */}
                  <select {...control('district')}>
                    <option value="">{t('selectDistrict')}</option>
                    {DISTRICTS.map((district) => <option key={district} value={district}>{t.district(district)}</option>)}
                  </select>
                  {error('district')}
                </div>
                {textField('place', { input: { autoComplete: 'address-level2' } })}
                {textField('shop_name', { input: { autoComplete: 'organization' } })}
                <div className="kyc-field">
                  {label('mobile')}
                  <div className="tech-phone">
                    <span className="tech-phone-code" aria-label={t('countryCode')}>+91</span>
                    <input {...control('mobile')} type="tel" inputMode="numeric" maxLength={16} autoComplete="tel-national" placeholder={t('mobilePlaceholder')} />
                  </div>
                  {error('mobile')}
                </div>
                <div className="kyc-field is-wide">
                  {label('address')}
                  <textarea {...control('address')} rows={3} maxLength={500} autoComplete="street-address" placeholder={t('addressPlaceholder')} />
                  {error('address')}
                </div>
                <div className="kyc-field">
                  {label('pincode')}
                  <input {...control('pincode')} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="postal-code" placeholder={t('pincodePlaceholder')} />
                  {error('pincode')}
                </div>
                <div className="kyc-field">
                  {label('state')}
                  <select {...control('state')}>
                    <option value="">{t('selectState')}</option>
                    {STATES.map((state) => <option key={state} value={state}>{t.state(state)}</option>)}
                  </select>
                  {error('state')}
                </div>
              </div>
            </section>

            {/* Section 2 — fields 9–12, all optional */}
            <section className="panel kyc-section" aria-labelledby="tech-section-extra">
              <header className="kyc-section-head">
                <span className="kyc-section-number" aria-hidden="true">2</span>
                <div>
                  <h2 id="tech-section-extra">{t('sectionExtra')}</h2>
                  <p className="muted-copy">{t('sectionExtraNote')}</p>
                </div>
              </header>
              <div className="kyc-grid">
                <div className="kyc-field">
                  {label('date_of_birth')}
                  <input {...control('date_of_birth')} type="date" min="1900-01-01" max={today} autoComplete="bday" />
                  {dateHint('date_of_birth')}
                  {error('date_of_birth')}
                </div>
                <div className="kyc-field">
                  {label('date_of_marriage')}
                  <input {...control('date_of_marriage')} type="date" min={values.date_of_birth || '1900-01-01'} max={today} />
                  {dateHint('date_of_marriage')}
                  {error('date_of_marriage')}
                </div>

                {/* Shop location: device location button, or a pasted Maps link */}
                <div className="kyc-field is-wide tech-location" role="group" aria-labelledby="tech-shop_location-label" aria-describedby={errors.shop_location ? 'tech-shop_location-error' : undefined}>
                  <span className="kyc-label" id="tech-shop_location-label">{t('shop_location')}</span>
                  <p className="field-help">{t('locationWhy')}</p>
                  {hasDeviceLocation ? (
                    <div className="tech-location-card">
                      <p className="tech-location-ok"><Icon name="check-circle" size={18} /> {t('locationCaptured')}</p>
                      <iframe
                        className="tech-map"
                        title={t('mapPreviewTitle')}
                        src={`https://maps.google.com/maps?q=${location.lat},${location.lng}&z=16&output=embed`}
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                      />
                      <p className="tech-coords" lang="en">
                        {location.lat}, {location.lng}
                        {location.accuracy != null && <small> · {t('locationAccuracy', { meters: location.accuracy })}</small>}
                      </p>
                      <div className="tech-location-actions">
                        <a className="secondary-btn tech-big-btn" href={mapsLink(location.lat, location.lng)} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> {t('openInMaps')}</a>
                        <button type="button" className="secondary-btn tech-big-btn" onClick={shareLocation}><Icon name="refresh" size={16} /> {t('updateLocation')}</button>
                        <button type="button" className="ghost-btn tech-big-btn" onClick={removeLocation}><Icon name="trash" size={16} /> {t('removeLocation')}</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button type="button" className="secondary-btn tech-big-btn tech-location-btn" onClick={shareLocation} disabled={location.status === 'locating'} aria-busy={location.status === 'locating'}>
                        {location.status === 'locating' ? <span className="tech-spinner" aria-hidden="true" /> : <Icon name="map-pin" size={20} />}
                        {location.status === 'locating' ? t('locating') : t('shareLocation')}
                      </button>
                      {locationMessage && <p className="notice info tech-location-note" role="status">{t(locationMessage)}</p>}
                      <label className="kyc-label tech-or" htmlFor="tech-shop_maps_url">{t('orPasteLink')}</label>
                      <input {...control('shop_maps_url')} type="url" inputMode="url" maxLength={500} autoCapitalize="off" spellCheck={false} placeholder={t('mapsLinkPlaceholder')} lang="en" />
                      <small className="field-help">{t('mapsLinkHelp')}</small>
                    </>
                  )}
                  {error('shop_location')}
                </div>

                {/* Aadhaar (optional upload) */}
                <div className="kyc-field is-wide">
                  <span className="kyc-label" id="tech-aadhaar-label">{t('aadhaar')}</span>
                  <div className={`kyc-doc tech-doc${errors.aadhaar ? ' has-error' : ''}${file ? ' has-file' : ''}`}>
                    <div className="kyc-doc-text">
                      <small className="field-help">{t('aadhaarHelp')}</small>
                      <small className="field-help tech-privacy"><Icon name="lock" size={14} /> {t('aadhaarPrivacy')}</small>
                    </div>
                    <div className="kyc-doc-control">
                      {preparingFile && <span className="field-help" role="status"><span className="tech-spinner" aria-hidden="true" /> {t('preparingFile')}</span>}
                      {file && !preparingFile && (
                        <span className="kyc-file-name" title={file.name}>
                          <Icon name="file" size={15} /> <span>{file.name}</span> <small>{formatBytes(file.size)}</small>
                        </span>
                      )}
                      <label className="secondary-btn kyc-file-btn tech-big-btn">
                        <input
                          id="tech-aadhaar"
                          type="file"
                          accept={DOCUMENT_ACCEPT}
                          className="visually-hidden"
                          aria-labelledby="tech-aadhaar-label"
                          aria-describedby={errors.aadhaar ? 'tech-aadhaar-error' : undefined}
                          aria-invalid={errors.aadhaar ? 'true' : undefined}
                          disabled={preparingFile}
                          onChange={(event) => { chooseFile(event.target.files?.[0] || null); event.target.value = '' }}
                        />
                        <Icon name="upload" size={16} /> {file ? t('replaceFile') : t('chooseFile')}
                      </label>
                      {file && <button type="button" className="ghost-btn tech-big-btn" onClick={() => chooseFile(null)}>{t('removeFile')}</button>}
                    </div>
                    {error('aadhaar')}
                  </div>
                </div>
              </div>
            </section>

            <div ref={noticeRef} className="kyc-submit-bar">
              {notice && <div className={`notice ${notice.type}`} role="alert">{t(notice.key, notice.vars)}</div>}
              <button type="submit" className="primary-btn tech-submit" disabled={submitting || preparingFile} aria-busy={submitting}>
                {submitting && <span className="tech-spinner" aria-hidden="true" />}
                {submitting ? t('submitting') : t('submit')}
              </button>
              <p className="field-help tech-secure"><Icon name="shield" size={14} /> {t('secureNote')}</p>
            </div>
          </form>
        )}
      </main>
      <footer className="page-footer">© {new Date().getFullYear()} <span lang="en">{t('companyName')}</span> · {t('footer')}</footer>
    </div>
  )
}
