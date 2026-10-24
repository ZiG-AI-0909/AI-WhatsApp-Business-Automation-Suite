import { useEffect, useState } from 'react'
import Badge from './components/Badge.jsx'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import { downloadResponse } from './utils/download.js'
import { formatBytes, formatDate } from './kyc/kycForm.js'
import { DOCUMENTS, REGISTRATION_SOURCE_META, STATUS_META, formatDmy } from './technician/technicianForm.js'

// ─────────────────────────────────────────────────────────────────────────────
// "Submitted forms" — mechanic / technician partner registrations, shown
// below the vendor KYC list (KycSubmissionsView). Same reviewers
// (private.kyc_staff); the backend enforces that on every /api/technicians route.
// ─────────────────────────────────────────────────────────────────────────────

const FORM_PATH = '/technician-registration'

// The 10 form fields, in form order (Aadhaar is under Documents).
const DETAIL_FIELDS = [
  ['full_name', 'Name'],
  ['district', 'District'],
  ['place', 'Place'],
  ['shop_name', 'Shop Name'],
  ['mobile', 'Contact Number'],
  ['address', 'Address', true],
  ['pincode', 'Pincode'],
  ['state', 'State'],
  ['date_of_birth', 'Date of Birth'],
  ['date_of_marriage', 'Date of Marriage'],
]

// A pending migration is a setup step, not an outage: show the server's
// "run supabase-…-migration.sql" message instead of the generic 5xx text.
function errorText(err, context) {
  return err?.code === 'TECH_MIGRATION_PENDING' ? err.message : friendlyErrorMessage(err, { context })
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || 'Pending', tone: 'neutral' }
  return <Badge tone={meta.tone} dot>{meta.label}</Badge>
}

/** "Self-registered", or the staff member who registered the partner. */
function RegisteredBy({ row }) {
  if (row.registration_source !== 'staff') return <span className="muted-copy">{REGISTRATION_SOURCE_META.self.label}</span>
  return (
    <>
      {row.staff_name}
      <small className="kyc-row-sub">{row.staff_code} · staff</small>
    </>
  )
}

/** Query params for the "Registered by" filter: '' | 'self' | 'staff' | a staff member's id. */
function registeredByParams(value) {
  if (!value) return {}
  if (value === 'self' || value === 'staff') return { source: value }
  return { source: 'staff', staff: value }
}

function CopyLinkButton() {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}${FORM_PATH}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy the form link:', url)
    }
  }
  return (
    <button type="button" className="secondary-btn" onClick={copy} title={url}>
      <Icon name={copied ? 'check-circle' : 'link'} size={15} /> {copied ? 'Link copied' : 'Copy form link'}
    </button>
  )
}

// ── List ────────────────────────────────────────────────────────────────────

export function TechnicianList({ onOpen, onOpenStaff, registeredBy = '', setRegisteredBy = () => {} }) {
  const [data, setData] = useState(null)
  const [roster, setRoster] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  // Staff names for the "Registered by" filter; without the staff migration
  // the list simply has no staff options.
  useEffect(() => {
    let cancelled = false
    apiFetch('/technicians/staff')
      .then((result) => { if (!cancelled) setRoster(result.staff || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const query = new URLSearchParams(Object.entries({ status, q, ...registeredByParams(registeredBy) }).filter(([, value]) => value)).toString()
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch(`/technicians${query ? `?${query}` : ''}`)
      .then((result) => { if (!cancelled) { setData(result); setError('') } })
      .catch((err) => { if (!cancelled) setError(errorText(err, 'Partner registrations')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query])

  const filtered = Boolean(status || q || registeredBy)
  const rows = data?.registrations || []

  // Same filters as the list, so the file matches what is on screen.
  const exportExcel = async () => {
    setExporting(true)
    try {
      // The staff member's name for the file's "Export info" sheet.
      const member = roster.find((row) => row.id === registeredBy)
      const exportQuery = member ? `${query}&staff_label=${encodeURIComponent(`${member.full_name} (${member.staff_code})`)}` : query
      await downloadResponse(await apiFetchRaw(`/technicians/export/excel${exportQuery ? `?${exportQuery}` : ''}`), 'technician-partner-registrations.xlsx')
    } catch (err) {
      setError(errorText(err, 'Excel export'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="view-workspace tech-list">
      <div className="view-toolbar">
        <div>
          <h2>Mechanic / technician partner registrations</h2>
          <p className="muted-copy">Forms submitted through the public partner registration page (English / Tamil). Open one to see the details and Aadhaar, and update the status.</p>
        </div>
        <div className="button-row">
          <CopyLinkButton />
          {onOpenStaff && <button type="button" className="secondary-btn" onClick={onOpenStaff}><Icon name="users" size={15} /> Staff members &amp; targets</button>}
          <button type="button" className="primary-btn" onClick={exportExcel} disabled={exporting || !rows.length}>
            <Icon name="download" size={15} /> {exporting ? 'Exporting…' : `Export Excel${filtered ? ' (filtered)' : ''}`}
          </button>
        </div>
      </div>

      <section className="panel kyc-filters" aria-label="Partner registration filters">
        <label className="form-label">Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
          </select>
        </label>
        <label className="form-label">Registered by
          <select value={registeredBy} onChange={(event) => setRegisteredBy(event.target.value)}>
            <option value="">Anyone</option>
            <option value="self">{REGISTRATION_SOURCE_META.self.label}</option>
            <option value="staff">{REGISTRATION_SOURCE_META.staff.label} (any staff)</option>
            {roster.length > 0 && (
              <optgroup label="Staff member">
                {roster.map((member) => <option key={member.id} value={member.id}>{member.full_name} ({member.staff_code}){member.active ? '' : ' – inactive'}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <label className="form-label kyc-filter-search">Search
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, shop, mobile, place, district, staff" />
        </label>
        {filtered && <button type="button" className="ghost-btn" onClick={() => { setSearch(''); setQ(''); setStatus(''); setRegisteredBy('') }}>Clear filters</button>}
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}

      {loading && !data ? (
        <div className="panel muted-copy" role="status">Loading partner registrations…</div>
      ) : !rows.length ? (
        <EmptyState
          icon="users"
          title={filtered ? 'No registrations match these filters' : 'No partner registrations yet'}
          description={filtered ? 'Change or clear the filters to see more.' : 'Share the partner registration link with mechanics and technicians. Their registrations will appear here.'}
        />
      ) : (
        <>
          <p className="muted-copy" role="status">
            Showing {rows.length}{data.total > rows.length ? ` of ${data.total}` : ''} {rows.length === 1 ? 'registration' : 'registrations'}{loading ? ' · updating…' : ''}
          </p>
          <div className="campaign-table-wrap">
            <table className="kyc-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Shop</th>
                  <th scope="col">Place</th>
                  <th scope="col">District</th>
                  <th scope="col">State</th>
                  <th scope="col">Contact number</th>
                  <th scope="col">Status</th>
                  <th scope="col">Registered by</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="kyc-row" onClick={() => onOpen(row.id)}>
                    <td>
                      <button type="button" className="kyc-row-link" onClick={(event) => { event.stopPropagation(); onOpen(row.id) }}>{row.full_name}</button>
                      <small className="kyc-row-sub">{row.reference}</small>
                    </td>
                    <td>
                      {row.shop_name || <span className="kyc-empty">—</span>}
                      {row.shop_maps_url && (
                        <small className="kyc-row-sub">
                          <a href={row.shop_maps_url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>Map</a>
                        </small>
                      )}
                    </td>
                    <td>{row.place}</td>
                    <td>{row.district}</td>
                    <td>{row.state}</td>
                    <td className="num">{row.mobile}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td><RegisteredBy row={row} /></td>
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
  if (key === 'mobile') return <a href={`tel:+91${value}`}>+91 {value}</a>
  if (key === 'date_of_birth' || key === 'date_of_marriage') return formatDmy(value)
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

export function TechnicianDetail({ id, onBack }) {
  const [registration, setRegistration] = useState(null)
  const [links, setLinks] = useState({})
  const [linksExpireAt, setLinksExpireAt] = useState(0)
  const [review, setReview] = useState(null)
  const [savedReview, setSavedReview] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const reviewFrom = (row) => ({ status: row.status || 'pending', review_remarks: row.review_remarks || '' })

  const load = async () => {
    try {
      const data = await apiFetch(`/technicians/${id}`)
      setRegistration(data.registration)
      setLinks(data.documentLinks || {})
      setLinksExpireAt(Date.now() + (data.linksExpireInSeconds || 600) * 1000 - 15000)
      setReview(reviewFrom(data.registration))
      setSavedReview(reviewFrom(data.registration))
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err, 'Registration'))
    }
  }
  useEffect(() => { load() }, [id])

  // Re-render periodically so expired document links are noticed.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  const dirty = JSON.stringify(review) !== JSON.stringify(savedReview)
  const linksExpired = now > linksExpireAt

  const back = () => {
    if (dirty && !window.confirm('Discard the unsaved review changes?')) return
    onBack()
  }

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    setFieldErrors({})
    try {
      const response = await apiFetchRaw(`/technicians/${id}/review`, {
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
      setRegistration((current) => ({ ...current, ...data.registration }))
      setReview(reviewFrom(data.registration))
      setSavedReview(reviewFrom(data.registration))
      setNotice({ type: 'success', text: `Saved. Status: ${STATUS_META[data.registration.status]?.label || data.registration.status}.` })
    } catch (err) {
      setNotice({ type: 'error', text: friendlyErrorMessage(err, { context: 'Save review' }) })
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
  if (!registration || !review) return <div className="panel muted-copy" role="status">Loading registration…</div>

  const err = (key) => fieldErrors[key] && <p className="kyc-error" role="alert">{fieldErrors[key]}</p>

  return (
    <div className="view-workspace kyc-detail">
      <div><button type="button" className="ghost-btn" onClick={back}><Icon name="chevron-left" size={16} /> All submissions</button></div>

      <div className="view-toolbar">
        <div>
          <p className="eyebrow">{registration.reference} · partner registration · submitted {formatDate(registration.submitted_at, { withTime: true })}</p>
          <h2>{registration.full_name}</h2>
          <div className="kyc-detail-meta">
            <StatusBadge status={registration.status} />
            {registration.registration_source === 'staff'
              ? <Badge tone={REGISTRATION_SOURCE_META.staff.tone}>Registered by staff: {registration.staff_name} ({registration.staff_code})</Badge>
              : <Badge tone={REGISTRATION_SOURCE_META.self.tone}>{REGISTRATION_SOURCE_META.self.label}</Badge>}
            {registration.reviewed_at && <span className="muted-copy">Last reviewed {formatDate(registration.reviewed_at, { withTime: true })}</span>}
          </div>
        </div>
      </div>

      <DetailSection number={1} title="Partner Details">
        <dl className="kyc-facts">
          {DETAIL_FIELDS.map(([key, label, wide]) => (
            <div key={key} className={wide ? 'is-wide' : undefined}>
              <dt>{label}</dt>
              <dd>{displayValue(key, registration[key])}</dd>
            </div>
          ))}
          <div className="is-wide">
            <dt>Shop Location</dt>
            <dd>
              {registration.shop_maps_url ? (
                <span className="kyc-attachment">
                  <a href={registration.shop_maps_url} target="_blank" rel="noopener noreferrer"><Icon name="map-pin" size={14} /> Open in Google Maps</a>
                  <small>
                    {registration.shop_location_source === 'device' ? 'Shared from the phone' : 'Link pasted by the partner'}
                    {registration.shop_latitude != null && ` · ${registration.shop_latitude}, ${registration.shop_longitude}`}
                    {registration.shop_location_accuracy_m != null && ` · ±${registration.shop_location_accuracy_m} m`}
                  </small>
                </span>
              ) : <span className="kyc-empty">Not provided</span>}
            </dd>
          </div>
        </dl>
      </DetailSection>

      <DetailSection number={2} title="Aadhaar Card">
        {linksExpired && Object.keys(links).length > 0 && (
          <div className="notice warning">Document links expire after 10 minutes for security. <button type="button" onClick={load}>Refresh links</button></div>
        )}
        {DOCUMENTS.map((document) => {
          const file = registration.documents?.[document.key]
          return (
            <p key={document.key} className="kyc-attachment">
              {file?.archived ? (
                <>
                  <span className="muted-copy"><Icon name="download" size={14} /> {document.label} archived offline</span>
                  <small>{formatDate(file.archived.at, { withTime: true })}{file.archived.by ? ` by ${file.archived.by}` : ''} · in {file.archived.archive}</small>
                </>
              ) : file ? (
                <>
                  {links[document.key] && !linksExpired
                    ? <a href={links[document.key]} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> Open {document.label}</a>
                    : <span className="muted-copy">Link expired</span>}
                  <small>{file.file_name} · {formatBytes(file.size)}</small>
                </>
              ) : <span className="kyc-empty">Not uploaded (optional)</span>}
            </p>
          )
        })}
      </DetailSection>

      <form onSubmit={save} className="kyc-review-form">
        <DetailSection number={3} title="Review">
          <div className="kyc-review-grid">
            <label className="form-label">Status
              <select value={review.status} onChange={(event) => setReview({ ...review, status: event.target.value })}>
                {Object.entries(STATUS_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
              </select>
              {err('status')}
            </label>
            <label className="form-label kyc-review-wide">Remarks
              <textarea value={review.review_remarks} onChange={(event) => setReview({ ...review, review_remarks: event.target.value })} maxLength={2000} rows={3} placeholder="Call notes, visit date, partner code…" />
              {err('review_remarks')}
            </label>
          </div>
          {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
          <div className="button-row">
            <button type="submit" className="primary-btn" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save review'}</button>
            {dirty && <span>Unsaved changes.</span>}
          </div>
        </DetailSection>
      </form>
    </div>
  )
}
