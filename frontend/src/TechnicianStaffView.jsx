import { useEffect, useMemo, useState } from 'react'
import Badge from './components/Badge.jsx'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import { downloadResponse } from './utils/download.js'
import { formatDate, todayInIndia } from './kyc/kycForm.js'
import { TARGET_PERIOD_LABELS } from './technician/technicianForm.js'
import { EMPLOYEE_FORM_PATH, EMPLOYEE_SOURCE_META, EMPLOYEE_STATES, filterEmployees } from './technician/employeeForm.js'

// ─────────────────────────────────────────────────────────────────────────────
// "Staff & targets" — employees (field staff) who register mechanics /
// technicians through the partner form's Staff mode. Employees register
// themselves through the public link /employee-registration (Employee ID
// SEPL-{STATE}{NNN} + initial PIN, see EmployeeRegistrationPage); KYC
// reviewers share that link, search and export the employee list, edit
// targets, activate / deactivate employees, and see each one's registrations.
// PINs are never shown here (only their hash exists).
// Every number comes from /api/technicians/staff/performance, which counts
// the registration rows themselves:
//   * Submitted  — Staff-mode registrations by that staff member.
//   * Counted    — the ones credited toward the target: the first
//                  registration of that mobile number that was not rejected.
//   * Not counted — the partner was already registered (by anyone).
// Self-registrations are never credited to a staff member.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_FORM = { full_name: '', phone: '', state: '', email: '', pin: '', target_count: '', target_period: 'month', account_email: '', active: true }

function errorText(err, context) {
  return err?.code === 'TECH_MIGRATION_PENDING' ? err.message : friendlyErrorMessage(err, { context })
}

// ── Date ranges (India time, inclusive yyyy-mm-dd) ──────────────────────────

function addDays(day, days) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function presetRange(preset) {
  const today = todayInIndia()
  const monthStart = `${today.slice(0, 8)}01`
  switch (preset) {
    case 'today': return { from: today, to: today }
    case 'week': return { from: addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)), to: today }
    case 'month': return { from: monthStart, to: today }
    case 'last_month': {
      const lastDay = addDays(monthStart, -1)
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay }
    }
    default: return { from: '', to: '' }
  }
}

const PRESETS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['all', 'All time'],
  ['custom', 'Custom'],
]

function TargetCell({ target }) {
  if (!target) return <span className="kyc-empty">No target</span>
  const percent = Math.min(100, target.percent)
  const period = { day: 'today', week: 'this week', month: 'this month' }[target.period]
  return (
    <div className="tech-target">
      <span><strong>{target.credited}</strong> / {target.target} {period}</span>
      <span className={`tech-target-bar${target.met ? ' is-met' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={`${target.percent}% of target ${period}`}>
        <i style={{ width: `${percent}%` }} />
      </span>
      <small>{target.met ? 'Target met' : `${target.percent}%`}</small>
    </div>
  )
}

// ── Edit an employee (new employees register through the public link) ──────

function StaffForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    full_name: initial.full_name,
    phone: initial.phone || '',
    state: initial.state || '',
    email: initial.email || '',
    target_count: initial.target_count ?? '',
    target_period: initial.target_period || 'month',
    account_email: initial.account_email || '',
    active: initial.active,
  }))
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    setFieldErrors({})
    try {
      const response = await apiFetchRaw(`/technicians/staff/${initial.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.staff) {
        setFieldErrors(data.fields || {})
        setNotice(data.error || `Could not save (${response.status}).`)
        return
      }
      // Saved; a link problem (unknown email) is reported but not fatal.
      onSaved(data.staff, data.fields?.account_email)
    } catch (err) {
      setNotice(friendlyErrorMessage(err, { context: 'Save staff member' }))
    } finally {
      setBusy(false)
    }
  }

  const err = (key) => fieldErrors[key] && <p className="kyc-error" role="alert">{fieldErrors[key]}</p>
  return (
    <form className="panel kyc-detail-section" onSubmit={save} aria-labelledby="tech-staff-form-title">
      <h3 className="kyc-detail-title" id="tech-staff-form-title">Edit {initial.full_name} ({initial.staff_code})</h3>
      <div className="kyc-review-grid">
        <label className="form-label">Employee ID
          <input value={initial.staff_code} disabled />
          <small className="field-help">The Employee ID never changes, even if the state changes; registrations keep it.</small>
        </label>
        <label className="form-label">Name
          <input value={form.full_name} onChange={set('full_name')} maxLength={120} required />
          {err('full_name')}
        </label>
        <label className="form-label">Mobile
          <input value={form.phone} onChange={set('phone')} inputMode="numeric" maxLength={16} placeholder="Optional" />
          {err('phone')}
        </label>
        <label className="form-label">State of operation
          <select value={form.state} onChange={set('state')}>
            <option value="">Not set</option>
            {EMPLOYEE_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
          </select>
          {err('state')}
        </label>
        <label className="form-label">Email
          <input type="email" value={form.email} onChange={set('email')} maxLength={254} placeholder="Optional" />
          {err('email')}
        </label>
        <label className="form-label">New PIN
          <input value={form.pin} onChange={set('pin')} inputMode="numeric" maxLength={8} autoComplete="new-password" placeholder="Leave empty to keep the PIN" />
          <small className="field-help">Give it to the employee in person. It is stored only as a hash; a new PIN also lifts a lock-out.</small>
          {err('pin')}
        </label>
        <label className="form-label">Registration target
          <span className="tech-target-input">
            <input value={form.target_count} onChange={set('target_count')} inputMode="numeric" maxLength={6} placeholder="No target" />
            <select value={form.target_period} onChange={set('target_period')} aria-label="Target period">
              {Object.entries(TARGET_PERIOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </span>
          {err('target_count')}
        </label>
        <label className="form-label">App account email
          <input type="email" value={form.account_email} onChange={set('account_email')} placeholder="Optional" />
          <small className="field-help">If this person signs in to this app, link their account and the form recognises them without a PIN.</small>
          {err('account_email')}
        </label>
        <label className="form-label tech-checkbox">
          <span><input type="checkbox" checked={form.active} onChange={set('active')} /> Active</span>
          <small className="field-help">Inactive employees cannot register partners. Their past registrations stay.</small>
        </label>
      </div>
      {notice && <div className="notice error" role="alert">{notice}</div>}
      <div className="button-row">
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

// ── Registration link ───────────────────────────────────────────────────────

function RegistrationLinkPanel() {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}${EMPLOYEE_FORM_PATH}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy the registration link:', url)
    }
  }
  return (
    <section className="panel emp-link-panel" aria-labelledby="emp-link-title">
      <div>
        <h3 id="emp-link-title" className="kyc-detail-title">Add staff members</h3>
        <p className="muted-copy">Share this link with new employees. They fill in their name, mobile number and state of operation, and get their Employee ID (e.g. SEPL-TN001) and initial PIN (the last 4 digits of their mobile) straight away. No app account is needed.</p>
        <code className="emp-link-url">{url}</code>
      </div>
      <div className="button-row">
        <button type="button" className="primary-btn" onClick={copy}>
          <Icon name={copied ? 'check-circle' : 'link'} size={15} /> {copied ? 'Link copied' : 'Copy Registration Link'}
        </button>
        <a className="secondary-btn" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} /> Open form</a>
      </div>
    </section>
  )
}

// ── Employee directory (search, state filter, status, export) ──────────────

function EmployeeDirectory({ roster, loading, onEdit, onChanged }) {
  const [search, setSearch] = useState('')
  const [state, setState] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState(null)

  const rows = useMemo(() => filterEmployees(roster, { q: search, state }), [roster, search, state])
  const byState = useMemo(() => {
    const counts = new Map()
    for (const row of roster) if (row.state) counts.set(row.state, (counts.get(row.state) || 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [roster])
  const activeCount = roster.filter((row) => row.active).length
  const filtered = Boolean(search.trim() || state)

  const toggleActive = async (row) => {
    if (row.active && !window.confirm(`Deactivate ${row.full_name} (${row.staff_code})? They will no longer be able to register partners. Their history stays.`)) return
    setBusyId(row.id)
    setMessage(null)
    try {
      const response = await apiFetchRaw(`/technicians/staff/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !row.active }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.staff) throw Object.assign(new Error(data.error || `Could not save (${response.status}).`), { status: response.status })
      setMessage({ type: 'success', text: `${data.staff.full_name} (${data.staff.staff_code}) is now ${data.staff.active ? 'active' : 'inactive'}.` })
      onChanged()
    } catch (err) {
      setMessage({ type: 'error', text: friendlyErrorMessage(err, { context: 'Change employee status' }) })
    } finally {
      setBusyId(null)
    }
  }

  const exportExcel = async () => {
    setExporting(true)
    setMessage(null)
    try {
      const query = new URLSearchParams(Object.entries({ q: search.trim(), state }).filter(([, value]) => value)).toString()
      await downloadResponse(await apiFetchRaw(`/technicians/staff/export/excel${query ? `?${query}` : ''}`), 'sepl-employees.xlsx')
    } catch (err) {
      setMessage({ type: 'error', text: errorText(err, 'Employee export') })
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="emp-directory" aria-labelledby="emp-directory-title">
      <div className="view-toolbar">
        <div>
          <h3 id="emp-directory-title">Registered employees</h3>
          <p className="muted-copy">PINs are never shown here. To give someone a new PIN, use Edit.</p>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-btn" onClick={exportExcel} disabled={exporting || !rows.length}>
            <Icon name="download" size={15} /> {exporting ? 'Exporting…' : `Export Excel${filtered ? ' (filtered)' : ''}`}
          </button>
        </div>
      </div>

      <div className="stats-grid compact-stats" aria-label="Employee totals">
        {[
          ['Total employees', roster.length, 'blue'],
          ['Active', activeCount, 'green'],
          ['Inactive', roster.length - activeCount, 'amber'],
          ['States covered', byState.length, 'blue'],
        ].map(([label, value, accent]) => <article className={`stat-card ${accent}`} key={label}><span>{label}</span><strong>{value}</strong></article>)}
      </div>
      {byState.length > 0 && (
        <div className="emp-state-chips" role="group" aria-label="Employees per state (click to filter)">
          {byState.map(([name, count]) => (
            <button type="button" key={name} className={`emp-chip${state === name ? ' is-active' : ''}`} aria-pressed={state === name} onClick={() => setState(state === name ? '' : name)}>
              {name} <strong>{count}</strong>
            </button>
          ))}
        </div>
      )}

      <section className="panel kyc-filters" aria-label="Employee filters">
        <label className="form-label kyc-filter-search">Search
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Employee ID, name, mobile or state" />
        </label>
        <label className="form-label">State
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">All states</option>
            {EMPLOYEE_STATES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {filtered && <button type="button" className="ghost-btn" onClick={() => { setSearch(''); setState('') }}>Clear filters</button>}
      </section>

      {message && <div className={`notice ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</div>}

      {loading && !roster.length ? (
        <div className="panel muted-copy" role="status">Loading employees…</div>
      ) : !rows.length ? (
        <EmptyState
          icon="users"
          title={filtered ? 'No employees match these filters' : 'No employees yet'}
          description={filtered ? 'Change or clear the filters to see more.' : 'Copy the registration link above and share it with new employees.'}
        />
      ) : (
        <>
          <p className="muted-copy" role="status">Showing {rows.length} of {roster.length} {roster.length === 1 ? 'employee' : 'employees'}</p>
          <div className="campaign-table-wrap">
            <table className="kyc-table">
              <thead>
                <tr>
                  <th scope="col">Employee ID</th>
                  <th scope="col">Name</th>
                  <th scope="col">Mobile</th>
                  <th scope="col">State</th>
                  <th scope="col">Registered</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const source = EMPLOYEE_SOURCE_META[row.registration_source] || EMPLOYEE_SOURCE_META.manual
                  return (
                    <tr key={row.id}>
                      <td><strong className="emp-id">{row.staff_code}</strong></td>
                      <td>
                        {row.full_name}
                        {row.email && <small className="kyc-row-sub">{row.email}</small>}
                      </td>
                      <td className="num">{row.phone ? <a href={`tel:+91${row.phone}`}>{row.phone}</a> : <span className="kyc-empty">—</span>}</td>
                      <td>{row.state || <span className="kyc-empty">Not set</span>}</td>
                      <td className="num">
                        {formatDate(row.created_at, { withTime: true })}
                        <small className="kyc-row-sub">{source.label}</small>
                      </td>
                      <td><Badge tone={row.active ? 'success' : 'neutral'} dot>{row.active ? 'Active' : 'Inactive'}</Badge></td>
                      <td>
                        <div className="button-row">
                          <button type="button" className="ghost-btn" onClick={() => toggleActive(row)} disabled={busyId === row.id}>
                            {busyId === row.id ? 'Saving…' : row.active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button type="button" className="secondary-btn" onClick={() => onEdit(row)}>Edit</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

// ── View ────────────────────────────────────────────────────────────────────

export default function TechnicianStaffView({ onBack, onShowRegistrations }) {
  const [preset, setPreset] = useState('month')
  const [custom, setCustom] = useState(() => presetRange('month'))
  const [report, setReport] = useState(null)
  const [roster, setRoster] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // null | staff row
  const [notice, setNotice] = useState(null)
  const [reload, setReload] = useState(0)

  const range = preset === 'custom' ? custom : presetRange(preset)
  const query = new URLSearchParams(Object.entries(range).filter(([, value]) => value)).toString()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([apiFetch(`/technicians/staff/performance${query ? `?${query}` : ''}`), apiFetch('/technicians/staff')])
      .then(([performance, list]) => {
        if (cancelled) return
        setReport(performance)
        setRoster(list.staff || [])
        setError('')
      })
      .catch((err) => { if (!cancelled) setError(errorText(err, 'Staff report')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, reload])

  const saved = (staff, linkWarning) => {
    setEditing(null)
    setNotice(linkWarning ? { type: 'warning', text: `Saved ${staff.full_name}. ${linkWarning}` } : { type: 'success', text: `Saved ${staff.full_name} (${staff.staff_code}).` })
    setReload((value) => value + 1)
  }

  const rosterById = new Map(roster.map((row) => [row.id, row]))
  const totals = report?.totals
  const rangeLabel = range.from || range.to ? `${range.from ? formatDate(range.from) : 'start'} – ${range.to ? formatDate(range.to) : 'today'}` : 'all time'

  return (
    <div className="view-workspace">
      <div><button type="button" className="ghost-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> All submissions</button></div>

      <div className="view-toolbar">
        <div>
          <h2>Staff members &amp; targets</h2>
          <p className="muted-copy">Employees register themselves through the registration link and use their Employee ID + PIN in the partner form's Staff mode.</p>
        </div>
      </div>

      <RegistrationLinkPanel />

      {editing && (
        <StaffForm key={editing.id} initial={editing} onSaved={saved} onCancel={() => setEditing(null)} />
      )}
      {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}

      <EmployeeDirectory
        roster={roster}
        loading={loading}
        onEdit={(member) => { setEditing(member); setNotice(null); window.scrollTo(0, 0) }}
        onChanged={() => setReload((value) => value + 1)}
      />

      <div className="view-toolbar emp-performance-head">
        <div>
          <h3>Partner registrations &amp; targets</h3>
          <p className="muted-copy">Partners registered by employees through the form's Staff mode. A registration counts toward a target once: when it is the first registration of that mobile number and not rejected. Self-registrations never count for staff.</p>
        </div>
      </div>

      <section className="panel kyc-filters" aria-label="Report period">
        <label className="form-label">Period
          <select value={preset} onChange={(event) => setPreset(event.target.value)}>
            {PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {preset === 'custom' && (
          <>
            <label className="form-label">From
              <input type="date" value={custom.from} max={custom.to || undefined} onChange={(event) => setCustom({ ...custom, from: event.target.value })} />
            </label>
            <label className="form-label">To
              <input type="date" value={custom.to} min={custom.from || undefined} onChange={(event) => setCustom({ ...custom, to: event.target.value })} />
            </label>
          </>
        )}
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}

      {totals && (
        <div className="stats-grid compact-stats" aria-label={`Totals, ${rangeLabel}`}>
          {[
            ['All registrations', totals.all, 'blue'],
            ['Self-registered', totals.self, 'green'],
            ['Staff-registered', totals.staff, 'amber'],
            ['Counted for staff', totals.credited, 'green'],
          ].map(([label, value, accent]) => <article className={`stat-card ${accent}`} key={label}><span>{label}</span><strong>{value}</strong></article>)}
        </div>
      )}

      {loading && !report ? (
        <div className="panel muted-copy" role="status">Loading staff report…</div>
      ) : !report?.staff?.length ? (
        <EmptyState icon="users" title="No staff members yet" description="Share the registration link above. Each employee gets an Employee ID and PIN to use in the partner form's Staff mode." />
      ) : (
        <>
          <p className="muted-copy" role="status">{rangeLabel} · targets show the current day, week or month{loading ? ' · updating…' : ''}</p>
          <div className="campaign-table-wrap">
            <table className="kyc-table">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col" className="num">Submitted</th>
                  <th scope="col" className="num">Counted</th>
                  <th scope="col" className="num">Not counted</th>
                  <th scope="col" className="num">Rejected</th>
                  <th scope="col">Target</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {report.staff.map((row) => {
                  const member = rosterById.get(row.id)
                  return (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.full_name}</strong>
                        <small className="kyc-row-sub">
                          {row.staff_code}
                          {!row.active && <> · <Badge tone="neutral">Inactive</Badge></>}
                          {member?.account_email && <> · {member.account_email}</>}
                        </small>
                      </td>
                      <td className="num">{row.submitted}</td>
                      <td className="num"><strong>{row.credited}</strong></td>
                      <td className="num">{row.duplicates}</td>
                      <td className="num">{row.rejected}</td>
                      <td><TargetCell target={row.target} /></td>
                      <td>
                        <div className="button-row">
                          {row.submitted > 0 && <button type="button" className="ghost-btn" onClick={() => onShowRegistrations(row)}>Registrations</button>}
                          {member && <button type="button" className="secondary-btn" onClick={() => { setEditing(member); setNotice(null) }}>Edit</button>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
