import { useEffect, useState } from 'react'
import Badge from './components/Badge.jsx'
import BrandLogo from './components/BrandLogo.jsx'
import EmptyState from './components/EmptyState.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import Icon from './components/Icon.jsx'
import { STATUS_META } from './technician/technicianForm.js'
import { LOGIN_PATH, clearStaffSession, readStaffSession, saveStaffSession, staffFetch } from './staff/staffSession.js'
import { formatIst } from './staff/istTime.js'

// ─────────────────────────────────────────────────────────────────────────────
// Staff dashboard (/staff/dashboard) — for one signed-in staff member
// (StaffLoginPage). Their personal partner-form link (copy, WhatsApp, QR),
// a "Fill form for a mechanic" shortcut (the form's Staff mode, already
// signed in), today / week / month / all-time totals with target progress,
// and the registrations credited to them. Every number and row comes from
// /api/staff-portal, which only returns the session's own data; mobiles
// arrive masked, and no documents, dates of birth / marriage or addresses
// are sent at all. All times are India time.
// ─────────────────────────────────────────────────────────────────────────────

export const FORM_PATH = '/technician-registration'
const SOURCE_LABELS = { referral: 'Mechanic via link', staff: 'Staff' }
const PERIOD_WORDS = { day: 'today', week: 'this week', month: 'this month' }
const NO_FILTERS = { from: '', to: '', source: '', status: '' }

function goToLogin() {
  clearStaffSession()
  window.location.replace(LOGIN_PATH)
}

/** Load once per `key`; a 401 sends the person back to the login page. */
function useStaffData(path, key) {
  const [state, setState] = useState({ data: null, error: '', loading: true })
  useEffect(() => {
    let cancelled = false
    setState((current) => ({ ...current, loading: true }))
    staffFetch(path)
      .then((data) => { if (!cancelled) setState({ data, error: '', loading: false }) })
      .catch((err) => {
        if (err.status === 401) return goToLogin()
        if (!cancelled) setState((current) => ({ ...current, error: err.message, loading: false }))
      })
    return () => { cancelled = true }
  }, [path, key])
  return state
}

// ── My registration link ────────────────────────────────────────────────────

function LinkCard({ staff }) {
  const { data, error } = useStaffData('/link', 0)
  const [copied, setCopied] = useState(false)
  const url = data?.url || ''
  const message = `Join the Sudarshan Pipes Partner Network! Register as a mechanic / technician partner here: ${url}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy your link:', url)
    }
  }

  return (
    <section className="panel staff-link" aria-labelledby="staff-link-title">
      <h2 id="staff-link-title">My registration link</h2>
      <p className="muted-copy">Share it with mechanics and technicians. Every partner who registers through it is credited to you ({staff.staff_code}).</p>
      {error ? <div className="notice error" role="alert">{error}</div> : !data ? (
        <p className="field-help" role="status"><span className="tech-spinner" aria-hidden="true" /> Preparing your link…</p>
      ) : (
        <div className="staff-link-body">
          <div className="staff-link-actions">
            <input className="staff-link-url" value={url} readOnly aria-label="Your registration link" onFocus={(event) => event.target.select()} lang="en" />
            <div className="button-row">
              <button type="button" className="secondary-btn tech-big-btn" onClick={copy}>
                <Icon name={copied ? 'check-circle' : 'link'} size={16} /> {copied ? 'Copied' : 'Copy'}
              </button>
              <a className="primary-btn tech-big-btn" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">
                <Icon name="chat" size={16} /> Share on WhatsApp
              </a>
            </div>
          </div>
          {/* The QR is an SVG made by our own backend; shown as an image, never injected as markup. */}
          <img className="staff-qr" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.qr_svg)}`} alt={`QR code for ${url}`} width={168} height={168} />
        </div>
      )}
      <a className="secondary-btn tech-big-btn staff-fill-btn" href={`${FORM_PATH}?mode=staff`}>
        <Icon name="clipboard" size={16} /> Fill form for a mechanic
      </a>
    </section>
  )
}

// ── Totals + target ─────────────────────────────────────────────────────────

function Summary({ reloadKey }) {
  const { data, error } = useStaffData('/summary', reloadKey)
  if (error) return <div className="notice error" role="alert">{error}</div>
  const counts = data?.counts
  const target = data?.target
  return (
    <section aria-label="My totals">
      <div className="stats-grid compact-stats staff-stats">
        {[['Today', counts?.today, 'blue'], ['This week', counts?.week, 'green'], ['This month', counts?.month, 'amber'], ['All time', counts?.all, 'blue']].map(([label, value, accent]) => (
          <article className={`stat-card ${accent}`} key={label}><span>{label}</span><strong>{value ?? '–'}</strong></article>
        ))}
      </div>
      {target && (
        <div className="panel staff-target">
          <div className="staff-target-head">
            <span>Target {PERIOD_WORDS[target.period]}</span>
            <strong>{target.credited} / {target.target}</strong>
          </div>
          <span className={`tech-target-bar${target.met ? ' is-met' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, target.percent))} aria-label={`${target.percent}% of your target ${PERIOD_WORDS[target.period]}`}>
            <i style={{ width: `${Math.min(100, target.percent)}%` }} />
          </span>
          <small className="field-help">{target.met ? 'Target met — well done!' : `${target.percent}% done.`} A partner counts once: the first time their mobile number is registered, unless rejected.</small>
        </div>
      )}
    </section>
  )
}

// ── Registrations ──────────────────────────────────────────────────────────

function Registrations() {
  const [filters, setFilters] = useState(NO_FILTERS)
  const [page, setPage] = useState(1)
  const params = new URLSearchParams(Object.entries({ ...filters, page: String(page) }).filter(([, value]) => value)).toString()
  const { data, error, loading } = useStaffData(`/registrations?${params}`, 0)
  const rows = data?.registrations || []
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1
  const filtered = Object.values(filters).some(Boolean)
  const setFilter = (key) => (event) => { setFilters({ ...filters, [key]: event.target.value }); setPage(1) }

  return (
    <section className="staff-registrations" aria-labelledby="staff-registrations-title">
      <h2 id="staff-registrations-title">My registrations</h2>
      <div className="panel kyc-filters" role="group" aria-label="Filters">
        <label className="form-label">From
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={setFilter('from')} />
        </label>
        <label className="form-label">To
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={setFilter('to')} />
        </label>
        <label className="form-label">Filled by
          <select value={filters.source} onChange={setFilter('source')}>
            <option value="">Anyone</option>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="form-label">Status
          <select value={filters.status} onChange={setFilter('status')}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
          </select>
        </label>
        {filtered && <button type="button" className="ghost-btn" onClick={() => { setFilters(NO_FILTERS); setPage(1) }}>Clear filters</button>}
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}
      {loading && !data ? (
        <div className="panel muted-copy" role="status">Loading your registrations…</div>
      ) : !rows.length ? (
        <EmptyState
          icon="users"
          title={filtered ? 'No registrations match these filters' : 'No registrations yet — share your link!'}
          description={filtered ? 'Change or clear the filters to see more.' : 'Partners who register through your link, or whose form you fill in, will appear here.'}
        />
      ) : (
        <>
          <p className="muted-copy" role="status">{data.total} {data.total === 1 ? 'registration' : 'registrations'}{loading ? ' · updating…' : ''}</p>
          <div className="campaign-table-wrap">
            <table className="kyc-table staff-table">
              <thead>
                <tr>
                  <th scope="col">Technician</th>
                  <th scope="col">Shop</th>
                  <th scope="col">District / place</th>
                  <th scope="col">Mobile</th>
                  <th scope="col">Filled by</th>
                  <th scope="col">Status</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = STATUS_META[row.status] || { label: row.status || 'Pending', tone: 'neutral' }
                  return (
                    <tr key={row.id}>
                      <td data-label="Technician"><strong>{row.full_name}</strong></td>
                      <td data-label="Shop">{row.shop_name || <span className="kyc-empty">—</span>}</td>
                      <td data-label="District / place">{[row.district, row.place].filter(Boolean).join(' · ')}</td>
                      <td data-label="Mobile" className="num" lang="en">{row.mobile}</td>
                      <td data-label="Filled by">{SOURCE_LABELS[row.registration_source] || '—'}</td>
                      <td data-label="Status"><Badge tone={status.tone} dot>{status.label}</Badge></td>
                      <td data-label="Submitted" className="num">{formatIst(row.submitted_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav className="button-row staff-pages" aria-label="Pages">
              <button type="button" className="secondary-btn" onClick={() => setPage(page - 1)} disabled={page <= 1 || loading}><Icon name="chevron-left" size={15} /> Newer</button>
              <span className="muted-copy">Page {page} of {pages}</span>
              <button type="button" className="secondary-btn" onClick={() => setPage(page + 1)} disabled={page >= pages || loading}>Older <Icon name="chevron-right" size={15} /></button>
            </nav>
          )}
        </>
      )}
    </section>
  )
}

// ── Change PIN (optional: the initial PIN keeps working) ────────────────────

function ChangePin({ onDone, onCancel }) {
  const [values, setValues] = useState({ current_pin: '', new_pin: '', confirm: '' })
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const set = (key) => (event) => setValues({ ...values, [key]: event.target.value.replace(/\D/g, '') })

  // Opened from the header or the bottom of the page: bring it into view, old PIN first.
  useEffect(() => {
    const input = document.getElementById('staff-current_pin')
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    input?.focus({ preventScroll: true })
  }, [])

  const save = async (event) => {
    event.preventDefault()
    if (!values.current_pin) { setErrors({ current_pin: 'Enter your old PIN first.' }); return }
    if (values.new_pin !== values.confirm) { setErrors({ confirm: 'The two new PINs are different.' }); return }
    setBusy(true)
    setErrors({})
    try {
      const session = await staffFetch('/pin', { method: 'POST', body: { current_pin: values.current_pin, new_pin: values.new_pin } })
      saveStaffSession(session) // the old session ends with the old PIN
      onDone(session.staff)
    } catch (err) {
      if (err.status === 401) return goToLogin()
      setErrors(Object.keys(err.fields).length ? err.fields : { form: err.message })
    } finally {
      setBusy(false)
    }
  }

  const field = (key, label, autoComplete) => (
    <div className="kyc-field">
      <label className="kyc-label" htmlFor={`staff-${key}`}>{label}</label>
      <input id={`staff-${key}`} type="password" inputMode="numeric" pattern="[0-9]*" maxLength={8} autoComplete={autoComplete} value={values[key]} onChange={set(key)} aria-invalid={errors[key] ? 'true' : undefined} />
      {errors[key] && <p className="kyc-error" role="alert">{errors[key]}</p>}
    </div>
  )
  return (
    <form className="panel staff-pin" onSubmit={save} aria-labelledby="staff-pin-title">
      <h2 id="staff-pin-title">Change PIN</h2>
      <p className="muted-copy">Enter your old PIN, then choose a new one. You will use the new PIN from your next sign-in; other phones signed in as you are signed out.</p>
      <div className="kyc-grid">
        {field('current_pin', 'Old PIN', 'current-password')}
        {field('new_pin', 'New PIN (4–8 digits)', 'new-password')}
        {field('confirm', 'New PIN again', 'new-password')}
      </div>
      {errors.form && <div className="notice error" role="alert">{errors.form}</div>}
      <div className="button-row">
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Save new PIN'}</button>
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function StaffDashboardPage() {
  const [staff, setStaff] = useState(() => readStaffSession()?.staff || null)
  const [changingPin, setChangingPin] = useState(false)
  const [notice, setNotice] = useState('')
  const [reminderHidden, setReminderHidden] = useState(false)

  useEffect(() => {
    document.title = 'My dashboard | Staff & Member Login'
    if (!readStaffSession()) { goToLogin(); return }
    // Fresh name / target / PIN state (the stored copy is from sign-in).
    staffFetch('/me')
      .then((data) => setStaff(data.staff))
      .catch((err) => { if (err.status === 401) goToLogin() })
  }, [])

  if (!staff) return <div className="kyc-page tech-page"><p className="panel muted-copy" role="status">Loading…</p></div>

  const openChangePin = () => {
    setNotice('')
    setChangingPin(true)
    // Already open (e.g. from the header while scrolled down): go back to it.
    const input = document.getElementById('staff-current_pin')
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    input?.focus({ preventScroll: true })
  }

  const pinDone = (next) => {
    setStaff(next)
    setChangingPin(false)
    setNotice('Your PIN has been changed. Use the new PIN next time you sign in.')
  }

  return (
    <div className="kyc-page tech-page" lang="en">
      <header className="landing-header tech-header">
        <div className="landing-header-inner">
          <span className="landing-brand"><BrandLogo height={28} /></span>
          <span className="staff-who">
            <strong>{staff.full_name}</strong>
            <small>{staff.staff_code}</small>
          </span>
          <ThemeToggle />
          <button type="button" className="ghost-btn staff-header-btn" onClick={openChangePin} aria-label="Change PIN" aria-expanded={changingPin}>
            <Icon name="lock" size={16} /> <span className="staff-btn-text">Change PIN</span>
          </button>
          <button type="button" className="ghost-btn staff-header-btn" onClick={goToLogin} aria-label="Logout">
            <Icon name="logout" size={16} /> <span className="staff-btn-text">Logout</span>
          </button>
        </div>
      </header>

      <main className="kyc-main tech-main staff-main" id="main-content">
        {staff.pin_must_change && !reminderHidden && !changingPin && (
          <div className="notice info staff-pin-reminder" role="status">
            <span>You are using your first PIN. You can keep using it, or change it to one only you know.</span>
            <span className="button-row">
              <button type="button" className="secondary-btn" onClick={openChangePin}>Change PIN</button>
              <button type="button" className="ghost-btn" onClick={() => setReminderHidden(true)}>Later</button>
            </span>
          </div>
        )}
        {notice && <div className="notice success" role="status">{notice}</div>}
        {changingPin && <ChangePin onDone={pinDone} onCancel={() => setChangingPin(false)} />}

        <LinkCard staff={staff} />
        <Summary reloadKey={staff.target_count} />
        <Registrations />

        {!changingPin && (
          <p className="staff-footer-actions">
            <button type="button" className="ghost-btn" onClick={openChangePin}><Icon name="lock" size={15} /> Change PIN</button>
          </p>
        )}
      </main>
      <footer className="page-footer">© {new Date().getFullYear()} <span lang="en">Sudarshan Extrusions Pvt. Ltd.</span> · Staff dashboard</footer>
    </div>
  )
}
