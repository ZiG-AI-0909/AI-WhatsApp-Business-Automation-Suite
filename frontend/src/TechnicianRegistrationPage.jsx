import { useEffect, useMemo, useRef, useState } from 'react'
import BrandLogo from './components/BrandLogo.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import Icon from './components/Icon.jsx'
import { API_URL } from './api.js'
import { formatBytes, todayInIndia } from './kyc/kycForm.js'
import {
  DISTRICTS, DOCUMENT_ACCEPT, FIELD_ORDER, INITIAL_VALUES, REQUIRED, STATES,
  formatDmy, validateDocument, validateField, validateForm,
} from './technician/technicianForm.js'
import { LANGUAGES, translator } from './technician/i18n.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public mechanic / technician partner registration
// (#/technician-registration or /technician-registration) — no sign-in.
// English / Tamil via technician/i18n.js; switching keeps everything typed.
// Staff review submissions under "Submitted forms" (TechnicianSubmissions).
// Uses the vendor KYC form's page styles (kyc-* classes).
// ─────────────────────────────────────────────────────────────────────────────

const LANG_STORAGE_KEY = 'sp-partner-form-lang'

function readLang() {
  try {
    return window.localStorage.getItem(LANG_STORAGE_KEY) === 'ta' ? 'ta' : 'en'
  } catch {
    return 'en'
  }
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

export default function TechnicianRegistrationPage() {
  const [lang, setLang] = useState(readLang)
  const t = useMemo(() => translator(lang), [lang])
  const [values, setValues] = useState(INITIAL_VALUES)
  const [file, setFile] = useState(null)
  const [errors, setErrors] = useState({})
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [result, setResult] = useState(null)
  const submittingRef = useRef(false)
  const noticeRef = useRef(null)
  const today = todayInIndia()
  const dirty = !result && (Boolean(file) || Object.values(values).some(Boolean))

  useEffect(() => { document.title = t('pageTitle') }, [t])

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

  const onChange = (name, value) => {
    const next = { ...values, [name]: value }
    setValues(next)
    // Once a field shows an error, re-check it as it is fixed.
    if (errors[name]) setFieldError(name, validateField(name, next))
    if (name === 'date_of_birth' && (errors.date_of_marriage || next.date_of_marriage)) setFieldError('date_of_marriage', validateField('date_of_marriage', next))
  }
  const onBlur = (name) => {
    if (attempted || String(values[name] ?? '').trim()) setFieldError(name, validateField(name, values))
  }

  const chooseFile = (next) => {
    setFile(next)
    setFieldError('aadhaar', validateDocument(next))
  }

  const focusFirst = (found) => {
    const first = FIELD_ORDER.find((key) => found[key])
    const element = first && document.getElementById(`tech-${first}`)
    if (element) {
      element.focus({ preventScroll: true })
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    if (submittingRef.current) return // no duplicate submissions
    setAttempted(true)
    const found = validateForm(values, { aadhaar: file })
    setErrors(found)
    if (Object.keys(found).length) {
      setNotice({ type: 'error', key: 'fixErrors', vars: { count: Object.keys(found).length } })
      focusFirst(found)
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    setNotice(null)
    const form = new FormData()
    for (const key of Object.keys(INITIAL_VALUES)) form.append(key, values[key] ?? '')
    if (file) form.append('aadhaar', file)
    try {
      const response = await fetch(`${API_URL}/public/technician`, { method: 'POST', body: form })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const fields = data.fields && typeof data.fields === 'object' ? data.fields : {}
        if (Object.keys(fields).length) {
          setErrors(fields)
          setNotice({ type: 'error', key: 'fixErrors', vars: { count: Object.keys(fields).length } })
          focusFirst(fields)
        } else {
          setNotice({ type: 'error', key: response.status === 429 ? 'rateLimited' : 'serverError' })
          noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        return
      }
      setResult(data)
      window.scrollTo(0, 0)
    } catch {
      setNotice({ type: 'error', key: 'networkError' })
      noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const reset = () => {
    setValues(INITIAL_VALUES)
    setFile(null)
    setErrors({})
    setAttempted(false)
    setNotice(null)
    setResult(null)
    window.scrollTo(0, 0)
  }

  // Shared props for every control; error text is rendered in the current language.
  const control = (name) => ({
    id: `tech-${name}`,
    name,
    value: values[name],
    onChange: (event) => onChange(name, event.target.value),
    onBlur: () => onBlur(name),
    'aria-invalid': errors[name] ? 'true' : undefined,
    'aria-describedby': errors[name] ? `tech-${name}-error` : undefined,
    'aria-required': REQUIRED.includes(name) ? 'true' : undefined,
  })
  const label = (name) => (
    <label className="kyc-label" htmlFor={`tech-${name}`}>
      {t(name)}
      {REQUIRED.includes(name) ? <span className="kyc-required" aria-hidden="true"> *</span> : <span className="kyc-optional"> {t('optional')}</span>}
    </label>
  )
  const error = (name) => errors[name] && <p id={`tech-${name}-error`} className="kyc-error" role="alert">{t.error(errors[name], name)}</p>
  const dateHint = (name) => values[name] && !errors[name] && <small className="field-help">{t('selectedDate', { date: formatDmy(values[name]) })}</small>

  return (
    <div className="kyc-page tech-page" lang={lang}>
      <header className="landing-header">
        <div className="landing-header-inner">
          <span className="landing-brand"><BrandLogo height={30} /></span>
          <span className="kyc-header-title">{t('headerTitle')}</span>
          <LanguageSwitcher lang={lang} onChange={changeLang} t={t} />
          <ThemeToggle />
        </div>
      </header>

      <main className="kyc-main" id="main-content">
        {result ? (
          <section className="panel kyc-success" aria-live="polite">
            <span className="kyc-success-icon" aria-hidden="true"><Icon name="check-circle" size={34} /></span>
            <h1>{t('successTitle')}</h1>
            <p>{t('successRef')}</p>
            <p className="kyc-reference">{result.reference}</p>
            <p className="muted-copy">{t('successBody', { mobile: `+91 ${values.mobile}` })}</p>
            <div className="button-row"><button type="button" className="secondary-btn" onClick={reset}>{t('registerAnother')}</button></div>
          </section>
        ) : (
          <form className="kyc-form" onSubmit={submit} noValidate>
            <section className="kyc-intro">
              <p className="eyebrow tech-company">
                <strong>{t('companyName')}</strong>
                <span>{t('tagline')}</span>
              </p>
              <h1>{t('heading')}</h1>
              <p className="muted-copy">{t('subheading')}</p>
              <p className="muted-copy">{t('requiredNote')}</p>
            </section>

            <section className="panel kyc-section" aria-label={t('heading')}>
              <div className="kyc-grid">
                {/* 1 Name */}
                <div className="kyc-field">
                  {label('full_name')}
                  <input {...control('full_name')} type="text" maxLength={120} autoComplete="name" placeholder={t('full_namePlaceholder')} />
                  {error('full_name')}
                </div>
                {/* 2 District — always Tamil Nadu districts */}
                <div className="kyc-field">
                  {label('district')}
                  <select {...control('district')}>
                    <option value="">{t('selectDistrict')}</option>
                    {DISTRICTS.map((district) => <option key={district} value={district}>{t.district(district)}</option>)}
                  </select>
                  {error('district')}
                </div>
                {/* 3 Place */}
                <div className="kyc-field">
                  {label('place')}
                  <input {...control('place')} type="text" maxLength={120} autoComplete="address-level2" placeholder={t('placePlaceholder')} />
                  {error('place')}
                </div>
                {/* 4 Contact number (+91) */}
                <div className="kyc-field">
                  {label('mobile')}
                  <div className="tech-phone">
                    <span className="tech-phone-code" aria-label={t('countryCode')}>+91</span>
                    <input {...control('mobile')} type="tel" inputMode="tel" maxLength={16} autoComplete="tel-national" placeholder={t('mobilePlaceholder')} />
                  </div>
                  {error('mobile')}
                </div>
                {/* 5 Address */}
                <div className="kyc-field is-wide">
                  {label('address')}
                  <textarea {...control('address')} rows={3} maxLength={500} autoComplete="street-address" placeholder={t('addressPlaceholder')} />
                  {error('address')}
                </div>
                {/* 6 Pincode */}
                <div className="kyc-field">
                  {label('pincode')}
                  <input {...control('pincode')} type="text" inputMode="numeric" maxLength={6} autoComplete="postal-code" placeholder={t('pincodePlaceholder')} />
                  {error('pincode')}
                </div>
                {/* 7 State */}
                <div className="kyc-field">
                  {label('state')}
                  <select {...control('state')}>
                    <option value="">{t('selectState')}</option>
                    {STATES.map((state) => <option key={state} value={state}>{t.state(state)}</option>)}
                  </select>
                  {error('state')}
                </div>
                {/* 8 Date of birth */}
                <div className="kyc-field">
                  {label('date_of_birth')}
                  <input {...control('date_of_birth')} type="date" min="1900-01-01" max={today} autoComplete="bday" />
                  {dateHint('date_of_birth')}
                  {error('date_of_birth')}
                </div>
                {/* 9 Date of marriage (optional) */}
                <div className="kyc-field">
                  {label('date_of_marriage')}
                  <input {...control('date_of_marriage')} type="date" min={values.date_of_birth || '1900-01-01'} max={today} />
                  {dateHint('date_of_marriage')}
                  {error('date_of_marriage')}
                </div>
                {/* 10 Aadhaar (optional upload) */}
                <div className="kyc-field is-wide">
                  <span className="kyc-label" id="tech-aadhaar-label">{t('aadhaar')}<span className="kyc-optional"> {t('optional')}</span></span>
                  <div className={`kyc-doc${errors.aadhaar ? ' has-error' : ''}${file ? ' has-file' : ''}`}>
                    <div className="kyc-doc-text">
                      <small className="field-help">{t('aadhaarHelp')}</small>
                      <small className="field-help"><Icon name="lock" size={13} /> {t('aadhaarPrivacy')}</small>
                    </div>
                    <div className="kyc-doc-control">
                      {file && (
                        <span className="kyc-file-name" title={file.name}>
                          <Icon name="file" size={15} /> <span>{file.name}</span> <small>{formatBytes(file.size)}</small>
                        </span>
                      )}
                      <label className="secondary-btn kyc-file-btn">
                        <input
                          id="tech-aadhaar"
                          type="file"
                          accept={DOCUMENT_ACCEPT}
                          className="visually-hidden"
                          aria-labelledby="tech-aadhaar-label"
                          aria-describedby={errors.aadhaar ? 'tech-aadhaar-error' : undefined}
                          aria-invalid={errors.aadhaar ? 'true' : undefined}
                          onChange={(event) => { chooseFile(event.target.files?.[0] || null); event.target.value = '' }}
                        />
                        <Icon name="upload" size={15} /> {file ? t('replaceFile') : t('chooseFile')}
                      </label>
                      {file && <button type="button" className="ghost-btn" onClick={() => chooseFile(null)}>{t('removeFile')}</button>}
                    </div>
                    {error('aadhaar')}
                  </div>
                </div>
              </div>
            </section>

            <div ref={noticeRef} className="kyc-submit-bar">
              {notice && <div className={`notice ${notice.type}`} role="alert">{t(notice.key, notice.vars)}</div>}
              <div className="button-row">
                <button type="submit" className="primary-btn tech-submit" disabled={submitting} aria-busy={submitting}>
                  {submitting && <span className="tech-spinner" aria-hidden="true" />}
                  {submitting ? t('submitting') : t('submit')}
                </button>
                <span>{t('secureNote')}</span>
              </div>
            </div>
          </form>
        )}
      </main>
      <footer className="page-footer">© {new Date().getFullYear()} {t('companyName')} · {t('footer')}</footer>
    </div>
  )
}
