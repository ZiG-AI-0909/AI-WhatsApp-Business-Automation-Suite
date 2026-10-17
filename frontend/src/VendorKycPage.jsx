import { useEffect, useRef, useState } from 'react'
import BrandLogo from './components/BrandLogo.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import Icon from './components/Icon.jsx'
import { API_URL } from './api.js'
import CategoryPicker from './kyc/CategoryPicker.jsx'
import {
  CONSENT_TEXT, DECLARATION_TEXT, DOCUMENTS, DOCUMENT_ACCEPT, FIELDS, FIELD_ORDER,
  INITIAL_VALUES, SECTIONS, formatBytes, formatDate, todayInIndia, toCategorySelections,
  validateCategorySelections, validateDocument, validateField, validateForm,
} from './kyc/kycForm.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public vendor KYC form (#/vendor-kyc or /vendor-kyc) — no sign-in.
// Sections 1–6 of the Sudarshan Extrusions "KYC Registration Form"; §7 is
// staff-only (KycSubmissionsView). There is no signature pad: vendors print
// the declaration, sign and seal it, and upload it as a mandatory document.
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_TYPES = { email: 'email', mobile: 'tel', phone: 'tel', url: 'text' }
const INPUT_MODES = { digits: 'numeric', int: 'numeric', mobile: 'tel', phone: 'tel', email: 'email', url: 'url' }

function Field({ name, values, errors, onChange, onBlur }) {
  const field = FIELDS[name]
  const id = `kyc-${name}`
  const error = errors[name]
  const common = {
    id,
    name,
    value: values[name] ?? '',
    onChange: (event) => onChange(name, event.target.value),
    onBlur: () => onBlur(name),
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': error ? `${id}-error` : undefined,
    'aria-required': field.required ? 'true' : undefined,
  }
  let control
  if (field.kind === 'select') {
    control = (
      <select {...common}>
        <option value="">Select…</option>
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    )
  } else if (field.kind === 'textarea') {
    control = <textarea {...common} rows={field.wide ? 3 : 2} maxLength={field.max} placeholder={field.placeholder} />
  } else {
    control = (
      <input
        {...common}
        type={INPUT_TYPES[field.kind] || 'text'}
        inputMode={INPUT_MODES[field.kind]}
        maxLength={field.kind === 'mobile' ? 16 : field.max}
        placeholder={field.placeholder}
        autoComplete={field.autoComplete || (name === 'bank_account_number_confirm' ? 'off' : undefined)}
        autoCapitalize={field.kind === 'code' ? 'characters' : undefined}
        spellCheck={field.kind === 'code' || field.kind === 'email' ? false : undefined}
        className={field.kind === 'code' ? 'kyc-code-input' : undefined}
      />
    )
  }
  return (
    <div className={`kyc-field${field.wide ? ' is-wide' : ''}`}>
      <label className="kyc-label" htmlFor={id}>
        {field.label}
        {field.required ? <span className="kyc-required" aria-hidden="true"> *</span> : <span className="kyc-optional"> (optional)</span>}
      </label>
      {control}
      {error && <p id={`${id}-error`} className="kyc-error" role="alert">{error}</p>}
    </div>
  )
}

function SectionCard({ number, title, intro, children }) {
  return (
    <section className="panel kyc-section" aria-labelledby={`kyc-section-${number}`}>
      <header className="kyc-section-head">
        <span className="kyc-section-number" aria-hidden="true">{number}</span>
        <div>
          <h2 id={`kyc-section-${number}`}>{title}</h2>
          {intro && <p className="muted-copy">{intro}</p>}
        </div>
      </header>
      {children}
    </section>
  )
}

/** Print-only sheet: the declaration page vendors sign, seal and upload. */
function DeclarationPrintSheet({ values }) {
  const line = (label, value) => (
    <tr><th>{label}</th><td>{value || ' '}</td></tr>
  )
  return (
    <div className="kyc-print-sheet" aria-hidden="true">
      <img src="/sudarshan-logo.png" alt="" className="kyc-print-logo" />
      <h1>KYC REGISTRATION FORM</h1>
      <p className="kyc-print-sub">Sudarshan Extrusions Pvt. Ltd. | Pipes &amp; Fittings</p>
      <h2>6. VENDOR DECLARATION</h2>
      <table className="kyc-print-table">
        <tbody>
          {line('Legal Business / Vendor Name', values.legal_name)}
          {line('PAN', values.pan?.toUpperCase())}
          {line('GSTIN', values.gstin?.toUpperCase())}
        </tbody>
      </table>
      <p className="kyc-print-declaration">{DECLARATION_TEXT}</p>
      <table className="kyc-print-table">
        <tbody>
          {line('Authorized Person Name', values.authorized_person_name)}
          {line('Designation', values.authorized_person_designation)}
          <tr className="kyc-print-sign"><th>Signature &amp; Company Seal</th><td>&nbsp;</td></tr>
          {line('Date', formatDate(todayInIndia()))}
        </tbody>
      </table>
      <p className="kyc-print-note">Sign above, stamp with the company seal, then scan or photograph this page and upload it as “Signed &amp; Sealed Declaration Page” in section 5 of the online form.</p>
    </div>
  )
}

export default function VendorKycPage() {
  const [values, setValues] = useState(INITIAL_VALUES)
  const [files, setFiles] = useState({})
  const [errors, setErrors] = useState({})
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [result, setResult] = useState(null)
  const noticeRef = useRef(null)
  const dirty = !result && (Object.keys(files).length > 0 || Object.entries(values).some(([key, value]) => (Array.isArray(value) ? value.length : value && value !== INITIAL_VALUES[key])))

  useEffect(() => { document.title = 'Vendor KYC Registration | Sudarshan Pipes' }, [])

  // Warn before leaving with a half-filled form.
  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const setFieldError = (key, message) => setErrors((current) => {
    if ((current[key] || '') === message) return current
    const next = { ...current }
    if (message) next[key] = message
    else delete next[key]
    return next
  })

  const onChange = (name, value) => {
    const next = { ...values, [name]: value }
    setValues(next)
    // Once a field shows an error, re-check it as the vendor fixes it.
    if (errors[name]) setFieldError(name, validateField(name, next))
    if (name === 'pan' && errors.gstin) setFieldError('gstin', validateField('gstin', next))
    if (name === 'bank_account_number' && values.bank_account_number_confirm) setFieldError('bank_account_number_confirm', validateField('bank_account_number_confirm', next))
  }
  const onBlur = (name) => {
    if (attempted || String(values[name] ?? '').trim()) setFieldError(name, validateField(name, values))
  }

  // Category picker: once the vendor has tried to submit (or an error is
  // showing), re-check the whole picker on every change.
  const isCategoryError = (key) => key === 'categories' || key.startsWith('category_')
  const changeCategories = (selections) => {
    setValues({ ...values, category_selections: selections })
    if (!attempted && !Object.keys(errors).some(isCategoryError)) return
    const found = validateCategorySelections(selections)
    setErrors((current) => ({
      ...Object.fromEntries(Object.entries(current).filter(([key]) => !isCategoryError(key))),
      ...found,
    }))
  }

  const chooseFile = (document, file) => {
    setFiles((current) => {
      const next = { ...current }
      if (file) next[document.key] = file
      else delete next[document.key]
      return next
    })
    const message = file ? validateDocument(document, file) : (attempted ? validateDocument(document, null) : '')
    setFieldError(document.key, message)
  }

  const focusFirst = (found) => {
    const first = FIELD_ORDER.find((key) => found[key])
    const element = first && (document.getElementById(`kyc-${first}`) || document.querySelector(`[data-kyc-focus="${first}"]`))
    if (element) {
      element.focus({ preventScroll: true })
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const printDeclaration = () => {
    document.body.classList.add('kyc-printing')
    const done = () => {
      document.body.classList.remove('kyc-printing')
      window.removeEventListener('afterprint', done)
    }
    window.addEventListener('afterprint', done)
    window.print()
  }

  const submit = async (event) => {
    event.preventDefault()
    if (submitting) return
    setAttempted(true)
    const found = validateForm(values, files)
    setErrors(found)
    if (Object.keys(found).length) {
      const count = Object.keys(found).length
      setNotice({ type: 'error', text: `Please fix ${count} ${count === 1 ? 'item' : 'items'} marked below, then submit again.` })
      focusFirst(found)
      return
    }
    setSubmitting(true)
    setNotice(null)
    const form = new FormData()
    for (const key of Object.keys(FIELDS)) form.append(key, values[key] ?? '')
    form.append('category_selections', JSON.stringify(toCategorySelections(values.category_selections)))
    form.append('declaration_accepted', values.declaration_accepted ? 'true' : 'false')
    for (const document of DOCUMENTS) {
      if (files[document.key]) form.append(document.key, files[document.key])
    }
    try {
      const response = await fetch(`${API_URL}/public/kyc`, { method: 'POST', body: form })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (data.fields && Object.keys(data.fields).length) {
          setErrors(data.fields)
          focusFirst(data.fields)
        }
        setNotice({ type: 'error', text: data.error || `The form could not be submitted (error ${response.status}). Please try again.` })
        if (!data.fields) noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      setResult(data)
      window.scrollTo(0, 0)
    } catch {
      setNotice({ type: 'error', text: 'Could not reach the server. Check your internet connection and try again. Your entries are still here.' })
      noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setValues(INITIAL_VALUES)
    setFiles({})
    setErrors({})
    setAttempted(false)
    setNotice(null)
    setResult(null)
    window.scrollTo(0, 0)
  }

  const fieldProps = { values, errors, onChange, onBlur }

  return (
    <div className="kyc-page">
      <header className="landing-header">
        <div className="landing-header-inner">
          <span className="landing-brand"><BrandLogo height={30} /></span>
          <span className="kyc-header-title">Vendor KYC Registration</span>
          <ThemeToggle />
        </div>
      </header>

      <main className="kyc-main" id="main-content">
        {result ? (
          <section className="panel kyc-success" aria-live="polite">
            <span className="kyc-success-icon" aria-hidden="true"><Icon name="check-circle" size={34} /></span>
            <h1>Thank you. Your KYC form has been submitted.</h1>
            <p>Your reference number is</p>
            <p className="kyc-reference">{result.reference}</p>
            <p className="muted-copy">Please keep this reference for any follow-up. The Sudarshan procurement team will review your details and documents and contact you at <strong>{values.contact_email}</strong> or <strong>{values.contact_mobile}</strong>. Submission does not by itself guarantee vendor approval or placement of an order.</p>
            <div className="button-row"><button type="button" className="secondary-btn" onClick={reset}>Submit another form</button></div>
          </section>
        ) : (
          <form className="kyc-form" onSubmit={submit} noValidate>
            <section className="kyc-intro">
              <p className="eyebrow">Sudarshan Extrusions Pvt. Ltd. | Pipes &amp; Fittings</p>
              <h1>Vendor KYC Registration Form</h1>
              <p className="muted-copy">Fill in your business, contact, supply and bank details and upload the supporting documents. Fields marked <span className="kyc-required">*</span> are required. It takes about 10 minutes.</p>
              <div className="notice info">
                <div>
                  <strong>Keep these ready</strong> (PDF, JPG or PNG, up to 5 MB each): PAN proof, GST registration certificate, cancelled cheque or bank proof, Udyam / MSME certificate, and the <strong>signed &amp; sealed declaration page</strong>. You can print the declaration page from section 6 once you have entered the authorized person’s name.
                </div>
              </div>
            </section>

            {SECTIONS.slice(0, 2).map((section) => (
              <SectionCard key={section.number} number={section.number} title={section.title}>
                <div className="kyc-grid">
                  {section.fields.map((name) => <Field key={name} name={name} {...fieldProps} />)}
                </div>
              </SectionCard>
            ))}

            <SectionCard number={3} title={SECTIONS[2].title} intro="Tick what you supply, then pick the items from each list. Choose “Other” only if an item is not listed.">
              <CategoryPicker value={values.category_selections} onChange={changeCategories} errors={errors} />
              <div className="kyc-grid">
                {SECTIONS[2].fields.map((name) => <Field key={name} name={name} {...fieldProps} />)}
              </div>
            </SectionCard>

            <SectionCard number={4} title={SECTIONS[3].title} intro="These details are used only for payments and are checked independently by our accounts team before use.">
              <div className="kyc-grid">
                {SECTIONS[3].fields.map((name) => <Field key={name} name={name} {...fieldProps} />)}
              </div>
            </SectionCard>

            <SectionCard number={5} title="Document Checklist" intro="PDF, JPG or PNG, up to 5 MB each. The first five are mandatory.">
              <ul className="kyc-docs">
                {DOCUMENTS.map((document) => {
                  const file = files[document.key]
                  const error = errors[document.key]
                  const id = `kyc-${document.key}`
                  return (
                    <li key={document.key} className={`kyc-doc${error ? ' has-error' : ''}${file ? ' has-file' : ''}`}>
                      <div className="kyc-doc-text">
                        <span className="kyc-doc-label" id={`${id}-label`}>{document.label}</span>
                        <span className={`kyc-tag${document.mandatory ? '' : ' is-optional'}`}>{document.mandatory ? 'Mandatory' : 'Optional'}</span>
                        {document.help && <small className="field-help">{document.help}</small>}
                      </div>
                      <div className="kyc-doc-control">
                        {file && (
                          <span className="kyc-file-name" title={file.name}>
                            <Icon name="file" size={15} /> <span>{file.name}</span> <small>{formatBytes(file.size)}</small>
                          </span>
                        )}
                        <label className="secondary-btn kyc-file-btn">
                          <input
                            id={id}
                            type="file"
                            accept={DOCUMENT_ACCEPT}
                            className="visually-hidden"
                            aria-labelledby={`${id}-label`}
                            aria-describedby={error ? `${id}-error` : undefined}
                            aria-invalid={error ? 'true' : undefined}
                            onChange={(event) => { chooseFile(document, event.target.files?.[0] || null); event.target.value = '' }}
                          />
                          <Icon name="upload" size={15} /> {file ? 'Replace' : 'Choose file'}
                        </label>
                        {file && <button type="button" className="ghost-btn" onClick={() => chooseFile(document, null)}>Remove</button>}
                      </div>
                      {error && <p id={`${id}-error`} className="kyc-error" role="alert">{error}</p>}
                    </li>
                  )
                })}
              </ul>
            </SectionCard>

            <SectionCard number={6} title="Vendor Declaration">
              <blockquote className="kyc-declaration">{DECLARATION_TEXT}</blockquote>
              <div className="kyc-grid">
                <Field name="authorized_person_name" {...fieldProps} />
                <Field name="authorized_person_designation" {...fieldProps} />
                <div className="kyc-field">
                  <span className="kyc-label">Date</span>
                  <p className="kyc-static">{formatDate(todayInIndia())}</p>
                </div>
                <div className="kyc-field kyc-print-cta">
                  <span className="kyc-label">Signature &amp; company seal</span>
                  <button type="button" className="secondary-btn" onClick={printDeclaration}><Icon name="download" size={15} /> Print declaration page</button>
                  <small className="field-help">Sign and seal the printed page, then upload it in section 5 as “Signed &amp; Sealed Declaration Page”.</small>
                </div>
              </div>
              <label className={`check-label kyc-consent${errors.declaration_accepted ? ' has-error' : ''}`}>
                <input
                  id="kyc-declaration_accepted"
                  type="checkbox"
                  checked={values.declaration_accepted}
                  aria-describedby={errors.declaration_accepted ? 'kyc-declaration_accepted-error' : undefined}
                  aria-invalid={errors.declaration_accepted ? 'true' : undefined}
                  onChange={(event) => {
                    setValues({ ...values, declaration_accepted: event.target.checked })
                    if (event.target.checked) setFieldError('declaration_accepted', '')
                  }}
                />
                <span>{CONSENT_TEXT}<span className="kyc-required" aria-hidden="true"> *</span></span>
              </label>
              {errors.declaration_accepted && <p id="kyc-declaration_accepted-error" className="kyc-error" role="alert">{errors.declaration_accepted}</p>}
            </SectionCard>

            <div ref={noticeRef} className="kyc-submit-bar">
              {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
              <div className="button-row">
                <button type="submit" className="primary-btn" disabled={submitting}>
                  {submitting ? 'Submitting… uploading documents' : 'Submit KYC form'}
                </button>
                <span>Your details are sent securely and are only visible to Sudarshan’s procurement and accounts teams.</span>
              </div>
            </div>
          </form>
        )}
      </main>
      <footer className="page-footer">© {new Date().getFullYear()} Sudarshan Extrusions Pvt. Ltd. · Vendor onboarding</footer>
      {!result && <DeclarationPrintSheet values={values} />}
    </div>
  )
}
