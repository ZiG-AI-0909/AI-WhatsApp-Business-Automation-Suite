import { useEffect, useMemo, useState } from 'react'
import Badge from './components/Badge.jsx'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import { downloadResponse } from './utils/download.js'
import { TechnicianDetail, TechnicianList } from './TechnicianSubmissions.jsx'
import {
  CHECK_STATUSES, DOCUMENTS, FIELDS, FINAL_DECISIONS, INTERNAL_CHECKS, SECTIONS, STATUS_META,
  formatBytes, formatDate,
} from './kyc/kycForm.js'

// ─────────────────────────────────────────────────────────────────────────────
// "Submitted forms" — staff review of public vendor KYC submissions.
// Only shown in the sidebar to users listed in private.kyc_staff; the
// backend enforces the same rule on every /api/kyc route.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS = { status: '', from: '', to: '', q: '', sort: 'newest' }
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Business name A–Z' },
  { value: 'status', label: 'Status' },
]
const REVIEW_KEYS = [
  ...INTERNAL_CHECKS.flatMap((check) => [`check_${check.key}`, `check_${check.key}_remarks`]),
  'procurement_reviewer', 'procurement_reviewed_on', 'finance_reviewer', 'finance_reviewed_on',
  'final_approver', 'final_approved_on', 'final_decision', 'decision_remarks', 'vendor_code',
]

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || 'Pending', tone: 'neutral' }
  return <Badge tone={meta.tone} dot>{meta.label}</Badge>
}

function filterParams(filters) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  return params.toString()
}

// ── List ────────────────────────────────────────────────────────────────────

function KycList({ filters, setFilters, onOpen }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [search, setSearch] = useState(filters.q)

  // Debounce the free-text search; the other filters apply immediately.
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((current) => (current.q === search.trim() ? current : { ...current, q: search.trim() })), 300)
    return () => window.clearTimeout(timer)
  }, [search, setFilters])

  const query = filterParams(filters)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch(`/kyc${query ? `?${query}` : ''}`)
      .then((result) => { if (!cancelled) { setData(result); setError('') } })
      .catch((err) => { if (!cancelled) setError(friendlyErrorMessage(err, { context: 'Submitted forms' })) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query])

  const exportExcel = async () => {
    setExporting(true)
    try {
      await downloadResponse(await apiFetchRaw(`/kyc/export/excel${query ? `?${query}` : ''}`), 'vendor-kyc-submissions.xlsx')
    } catch (err) {
      setError(friendlyErrorMessage(err, { context: 'Excel export' }))
    } finally {
      setExporting(false)
    }
  }

  const update = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }))
  const filtered = Boolean(filters.status || filters.from || filters.to || filters.q)
  const rows = data?.submissions || []

  return (
    <div className="view-workspace">
      <div className="view-toolbar">
        <div>
          <h2>Vendor KYC submissions</h2>
          <p className="muted-copy">Forms submitted through the public vendor KYC page. Open one to review documents and record the internal verification.</p>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-btn" onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/vendor-kyc`)} title={`${window.location.origin}/vendor-kyc`}>
            <Icon name="link" size={15} /> Copy form link
          </button>
          <button type="button" className="primary-btn" onClick={exportExcel} disabled={exporting || !rows.length}>
            <Icon name="download" size={15} /> {exporting ? 'Exporting…' : `Export Excel${filtered ? ' (filtered)' : ''}`}
          </button>
        </div>
      </div>

      <section className="panel kyc-filters" aria-label="Filters">
        <label className="form-label">Status
          <select value={filters.status} onChange={update('status')}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
          </select>
        </label>
        <label className="form-label">Submitted from
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={update('from')} />
        </label>
        <label className="form-label">Submitted to
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={update('to')} />
        </label>
        <label className="form-label">Sort
          <select value={filters.sort} onChange={update('sort')}>
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="form-label kyc-filter-search">Search
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Business, contact, mobile, GSTIN, vendor code" />
        </label>
        {filtered && <button type="button" className="ghost-btn" onClick={() => { setSearch(''); setFilters(DEFAULT_FILTERS) }}>Clear filters</button>}
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}

      {loading && !data ? (
        <div className="panel muted-copy" role="status">Loading submitted forms…</div>
      ) : !rows.length ? (
        <EmptyState
          icon="receipt"
          title={filtered ? 'No submissions match these filters' : 'No vendor KYC forms yet'}
          description={filtered ? 'Change or clear the filters to see more.' : 'Share the vendor KYC form link with new vendors. Their submissions will appear here.'}
        />
      ) : (
        <>
          <p className="muted-copy" role="status">
            Showing {rows.length}{data.total > rows.length ? ` of ${data.total}` : ''} {rows.length === 1 ? 'submission' : 'submissions'}{loading ? ' · updating…' : ''}
          </p>
          <div className="campaign-table-wrap">
            <table className="kyc-table">
              <thead>
                <tr>
                  <th scope="col">Legal business name</th>
                  <th scope="col">Contact person</th>
                  <th scope="col">Mobile</th>
                  <th scope="col">Status</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="kyc-row" onClick={() => onOpen(row.id)}>
                    <td>
                      <button type="button" className="kyc-row-link" onClick={(event) => { event.stopPropagation(); onOpen(row.id) }}>{row.legal_name}</button>
                      <small className="kyc-row-sub">{row.reference}{row.vendor_code ? ` · ${row.vendor_code}` : ''}</small>
                    </td>
                    <td>{row.contact_name}</td>
                    <td className="num">{row.contact_mobile}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td className="num">{formatDate(row.submitted_at, { withTime: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── Detail ──────────────────────────────────────────────────────────────────

function displayValue(key, value) {
  if (value === null || value === undefined || value === '') return <span className="kyc-empty">Not provided</span>
  if (key === 'website') return <a href={value} target="_blank" rel="noopener noreferrer">{value}</a>
  if (key === 'contact_email') return <a href={`mailto:${value}`}>{value}</a>
  if (key === 'contact_mobile') return <a href={`tel:+91${value}`}>{value}</a>
  return String(value)
}

function DetailSection({ number, title, children }) {
  return (
    <section className="panel kyc-detail-section">
      <h3 className="kyc-detail-title"><span className="kyc-section-number" aria-hidden="true">{number}</span>{title}</h3>
      {children}
    </section>
  )
}

function Facts({ keys, submission }) {
  return (
    <dl className="kyc-facts">
      {keys.map((key) => (
        <div key={key} className={FIELDS[key]?.wide ? 'is-wide' : undefined}>
          <dt>{FIELDS[key]?.label || key}</dt>
          <dd>{displayValue(key, submission[key])}</dd>
        </div>
      ))}
    </dl>
  )
}

function reviewFrom(submission) {
  const review = Object.fromEntries(REVIEW_KEYS.map((key) => [key, submission[key] ?? '']))
  for (const check of INTERNAL_CHECKS) review[`check_${check.key}`] ||= 'pending'
  review.documents_verified = Object.fromEntries(DOCUMENTS.map((document) => [document.key, submission.documents_verified?.[document.key] === 'yes' ? 'yes' : 'pending']))
  return review
}

function KycDetail({ id, onBack }) {
  const [submission, setSubmission] = useState(null)
  const [links, setLinks] = useState({})
  const [linksExpireAt, setLinksExpireAt] = useState(0)
  const [review, setReview] = useState(null)
  const [savedReview, setSavedReview] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = async () => {
    try {
      const data = await apiFetch(`/kyc/${id}`)
      setSubmission(data.submission)
      setLinks(data.documentLinks || {})
      setLinksExpireAt(Date.now() + (data.linksExpireInSeconds || 600) * 1000 - 15000)
      const next = reviewFrom(data.submission)
      setReview(next)
      setSavedReview(next)
      setLoadError('')
    } catch (err) {
      setLoadError(friendlyErrorMessage(err, { context: 'Submission' }))
    }
  }
  useEffect(() => { load() }, [id])

  // Re-render once a minute so expired document links are noticed.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  const dirty = useMemo(() => JSON.stringify(review) !== JSON.stringify(savedReview), [review, savedReview])
  const linksExpired = now > linksExpireAt

  const back = () => {
    if (dirty && !window.confirm('Discard the unsaved review changes?')) return
    onBack()
  }
  const set = (key) => (event) => setReview((current) => ({ ...current, [key]: event.target.value }))
  const setDocVerified = (key, value) => setReview((current) => ({ ...current, documents_verified: { ...current.documents_verified, [key]: value } }))

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    setFieldErrors({})
    try {
      const response = await apiFetchRaw(`/kyc/${id}/review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(review),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setFieldErrors(data.fields || {})
        setNotice({ type: 'error', text: data.error || `Could not save the review (${response.status}).` })
        return
      }
      setSubmission((current) => ({ ...current, ...data.submission }))
      const next = reviewFrom(data.submission)
      setReview(next)
      setSavedReview(next)
      setNotice({ type: 'success', text: `Review saved. Status: ${STATUS_META[data.submission.status]?.label || data.submission.status}.` })
    } catch (err) {
      setNotice({ type: 'error', text: friendlyErrorMessage(err, { context: 'Save review' }) })
    } finally {
      setBusy(false)
    }
  }

  const downloadPdf = async () => {
    setBusy(true)
    try {
      await downloadResponse(await apiFetchRaw(`/kyc/${id}/export/pdf`), `KYC_${submission.reference}.pdf`)
    } catch (err) {
      setNotice({ type: 'error', text: friendlyErrorMessage(err, { context: 'PDF export' }) })
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return (
      <div className="view-workspace">
        <div><button type="button" className="ghost-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> All submissions</button></div>
        <div className="notice error" role="alert">{loadError}</div>
      </div>
    )
  }
  if (!submission || !review) return <div className="panel muted-copy" role="status">Loading submission…</div>

  const err = (key) => fieldErrors[key] && <p className="kyc-error" role="alert">{fieldErrors[key]}</p>
  const selections = Array.isArray(submission.category_selections) ? submission.category_selections : []

  return (
    <div className="view-workspace kyc-detail">
      <div><button type="button" className="ghost-btn" onClick={back}><Icon name="chevron-left" size={16} /> All submissions</button></div>

      <div className="view-toolbar">
        <div>
          <p className="eyebrow">{submission.reference} · submitted {formatDate(submission.submitted_at, { withTime: true })}</p>
          <h2>{submission.legal_name}</h2>
          <div className="kyc-detail-meta">
            <StatusBadge status={submission.status} />
            {submission.vendor_code && <Badge tone="neutral">Vendor code {submission.vendor_code}</Badge>}
            {submission.reviewed_at && <span className="muted-copy">Last reviewed {formatDate(submission.reviewed_at, { withTime: true })}</span>}
          </div>
        </div>
        <div className="button-row">
          <button type="button" className="primary-btn" onClick={downloadPdf} disabled={busy}><Icon name="download" size={15} /> Download PDF</button>
        </div>
      </div>

      <DetailSection number={1} title="Vendor / Business Details"><Facts keys={SECTIONS[0].fields} submission={submission} /></DetailSection>
      <DetailSection number={2} title="Contact Details"><Facts keys={SECTIONS[1].fields} submission={submission} /></DetailSection>
      <DetailSection number={3} title="Vendor Category & Supply Details">
        <dl className="kyc-facts">
          {selections.length ? selections.map((selection) => (
            <div key={selection.category} className="is-wide">
              <dt>{selection.category}</dt>
              <dd className="kyc-chips">
                {selection.items.map((item) => <Badge key={item} tone="cold">{item}</Badge>)}
                {/* Older "Other" entries stored only their text (no list then). */}
                {selection.other_text && <Badge tone="neutral">{selection.category === 'Other' && !selection.items.length ? selection.other_text : `Other: ${selection.other_text}`}</Badge>}
              </dd>
            </div>
          )) : <div className="is-wide"><dt>Category</dt><dd><span className="kyc-empty">Not provided</span></dd></div>}
        </dl>
        <Facts keys={SECTIONS[2].fields} submission={submission} />
      </DetailSection>
      <DetailSection number={4} title="Bank & Payment Details">
        <Facts keys={SECTIONS[3].fields.filter((key) => key !== 'bank_account_number_confirm')} submission={submission} />
      </DetailSection>

      <form onSubmit={save} className="kyc-review-form">
        <DetailSection number={5} title="Document Checklist">
          {linksExpired && Object.keys(links).length > 0 && (
            <div className="notice warning">Document links expire after 10 minutes for security. <button type="button" onClick={load}>Refresh links</button></div>
          )}
          <div className="campaign-table-wrap">
            <table className="kyc-table">
              <thead><tr><th scope="col">Document</th><th scope="col">Attached</th><th scope="col">Verified by company</th></tr></thead>
              <tbody>
                {DOCUMENTS.map((document) => {
                  const file = submission.documents?.[document.key]
                  return (
                    <tr key={document.key}>
                      <td>
                        {document.label}
                        {document.mandatory && <> <Badge tone="cold">Mandatory</Badge></>}
                      </td>
                      <td>
                        {file?.archived ? (
                          <span className="kyc-attachment">
                            <span className="muted-copy"><Icon name="download" size={14} /> Archived offline</span>
                            <small title={file.archived.archive}>{file.file_name} · {formatDate(file.archived.at, { withTime: true })}{file.archived.by ? ` by ${file.archived.by}` : ''} · in {file.archived.archive}</small>
                          </span>
                        ) : file ? (
                          <span className="kyc-attachment">
                            {links[document.key] && !linksExpired
                              ? <a href={links[document.key]} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> Open</a>
                              : <span className="muted-copy">Link expired</span>}
                            <small title={file.file_name}>{file.file_name} · {formatBytes(file.size)}</small>
                          </span>
                        ) : <span className="kyc-empty">N/A</span>}
                      </td>
                      <td>
                        {file ? (
                          <select aria-label={`${document.label}: verified by company`} value={review.documents_verified[document.key]} onChange={(event) => setDocVerified(document.key, event.target.value)}>
                            <option value="pending">Pending</option>
                            <option value="yes">Yes</option>
                          </select>
                        ) : <span className="kyc-empty">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </DetailSection>

        <DetailSection number={6} title="Vendor Declaration">
          <dl className="kyc-facts">
            <div><dt>Authorized Person Name</dt><dd>{displayValue('', submission.authorized_person_name)}</dd></div>
            <div><dt>Designation</dt><dd>{displayValue('', submission.authorized_person_designation)}</dd></div>
            <div><dt>Date</dt><dd>{formatDate(submission.declaration_date)}</dd></div>
            <div><dt>Confirmation</dt><dd>{submission.declaration_accepted ? 'Ticked online' : 'Not ticked'}</dd></div>
            <div className="is-wide"><dt>Signature &amp; company seal</dt><dd>{submission.documents?.signed_declaration ? 'On the uploaded “Signed & Sealed Declaration Page” (section 5).' : <span className="kyc-empty">Not uploaded</span>}</dd></div>
          </dl>
        </DetailSection>

        <DetailSection number={7} title="Internal Verification & Approval">
          <div className="campaign-table-wrap">
            <table className="kyc-table kyc-checks-table">
              <thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">Remarks / reference</th></tr></thead>
              <tbody>
                {INTERNAL_CHECKS.map((check) => (
                  <tr key={check.key}>
                    <td>{check.label}</td>
                    <td>
                      <div className="kyc-radio-group" role="radiogroup" aria-label={check.label}>
                        {CHECK_STATUSES.map((option) => (
                          <label key={option.value} className="check-label">
                            <input type="radio" name={`check_${check.key}`} value={option.value} checked={review[`check_${check.key}`] === option.value} onChange={set(`check_${check.key}`)} />
                            {option.label}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td>
                      <input type="text" aria-label={`${check.label}: remarks`} value={review[`check_${check.key}_remarks`]} onChange={set(`check_${check.key}_remarks`)} maxLength={500} />
                      {err(`check_${check.key}_remarks`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="kyc-review-grid">
            {[
              ['procurement_reviewer', 'procurement_reviewed_on', 'Procurement reviewer'],
              ['finance_reviewer', 'finance_reviewed_on', 'Accounts / finance reviewer'],
              ['final_approver', 'final_approved_on', 'Final approver'],
            ].map(([name, date, label]) => (
              <div key={name} className="kyc-review-pair">
                <label className="form-label">{label}<input type="text" value={review[name]} onChange={set(name)} maxLength={120} />{err(name)}</label>
                <label className="form-label">Date<input type="date" value={review[date]} onChange={set(date)} />{err(date)}</label>
              </div>
            ))}
          </div>

          <fieldset className="kyc-fieldset">
            <legend className="kyc-label">Final decision</legend>
            <div className="kyc-radio-group">
              <label className="check-label"><input type="radio" name="final_decision" value="" checked={!review.final_decision} onChange={set('final_decision')} />No decision yet</label>
              {FINAL_DECISIONS.map((option) => (
                <label key={option.value} className="check-label">
                  <input type="radio" name="final_decision" value={option.value} checked={review.final_decision === option.value} onChange={set('final_decision')} />
                  {option.label}
                </label>
              ))}
            </div>
            {err('final_decision')}
          </fieldset>

          <div className="kyc-review-grid">
            <label className="form-label">Vendor code
              <input type="text" value={review.vendor_code} onChange={set('vendor_code')} maxLength={40} placeholder="Assigned on approval" className="kyc-code-input" />
              <small>Required to approve. Must be unique.</small>
              {err('vendor_code')}
            </label>
            <label className="form-label kyc-review-wide">Decision remarks
              <textarea value={review.decision_remarks} onChange={set('decision_remarks')} maxLength={2000} rows={3} placeholder="Required when further information is needed: say what is missing." />
              {err('decision_remarks')}
            </label>
          </div>

          {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
          <div className="button-row">
            <button type="submit" className="primary-btn" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save review'}</button>
            <span>{dirty ? 'Unsaved changes.' : 'Status updates automatically from the checks and the final decision.'}</span>
          </div>
        </DetailSection>
      </form>
    </div>
  )
}

export default function KycSubmissionsView() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  // { form: 'kyc' | 'technician', id } — the open submission, if any.
  const [selected, setSelected] = useState(null)
  const back = () => setSelected(null)
  if (selected?.form === 'kyc') return <KycDetail id={selected.id} onBack={back} />
  if (selected?.form === 'technician') return <TechnicianDetail id={selected.id} onBack={back} />
  return (
    <div className="kyc-forms-stack">
      <KycList filters={filters} setFilters={setFilters} onOpen={(id) => setSelected({ form: 'kyc', id })} />
      <TechnicianList onOpen={(id) => setSelected({ form: 'technician', id })} />
    </div>
  )
}
