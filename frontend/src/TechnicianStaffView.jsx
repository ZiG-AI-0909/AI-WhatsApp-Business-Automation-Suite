import { useEffect, useState } from 'react'
import Badge from './components/Badge.jsx'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import { formatDate, todayInIndia } from './kyc/kycForm.js'
import { TARGET_PERIOD_LABELS } from './technician/technicianForm.js'

// ─────────────────────────────────────────────────────────────────────────────
// "Staff & targets" — field staff who register mechanics / technicians
// through the partner form's Staff mode. KYC reviewers add staff (Staff ID +
// PIN + optional target), deactivate them, and see each one's registrations.
// Every number comes from /api/technicians/staff/performance, which counts
// the registration rows themselves:
//   * Submitted  — Staff-mode registrations by that staff member.
//   * Counted    — the ones credited toward the target: the first
//                  registration of that mobile number that was not rejected.
//   * Not counted — the partner was already registered (by anyone).
// Self-registrations are never credited to a staff member.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_FORM = { staff_code: '', full_name: '', phone: '', pin: '', target_count: '', target_period: 'month', account_email: '', active: true }

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

// ── Add / edit a staff member ────────────────────────────────────────────────

function StaffForm({ initial, onSaved, onCancel }) {
  const editing = Boolean(initial)
  const [form, setForm] = useState(() => (initial
    ? { ...EMPTY_FORM, ...initial, phone: initial.phone || '', target_count: initial.target_count ?? '', account_email: initial.account_email || '', pin: '' }
    : EMPTY_FORM))
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    setFieldErrors({})
    const body = { ...form }
    if (editing) delete body.staff_code
    try {
      const response = await apiFetchRaw(editing ? `/technicians/staff/${initial.id}` : '/technicians/staff', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
      <h3 className="kyc-detail-title" id="tech-staff-form-title">{editing ? `Edit ${initial.full_name} (${initial.staff_code})` : 'Add a staff member'}</h3>
      <div className="kyc-review-grid">
        <label className="form-label">Staff ID
          <input value={form.staff_code} onChange={set('staff_code')} maxLength={20} placeholder="SE-014" disabled={editing} autoCapitalize="characters" required={!editing} />
          {editing ? <small className="field-help">The Staff ID cannot be changed; registrations keep it.</small> : err('staff_code')}
        </label>
        <label className="form-label">Name
          <input value={form.full_name} onChange={set('full_name')} maxLength={120} required />
          {err('full_name')}
        </label>
        <label className="form-label">Mobile
          <input value={form.phone} onChange={set('phone')} inputMode="numeric" maxLength={16} placeholder="Optional" />
          {err('phone')}
        </label>
        <label className="form-label">{editing ? 'New PIN' : 'PIN'}
          <input value={form.pin} onChange={set('pin')} inputMode="numeric" maxLength={8} autoComplete="new-password" placeholder={editing ? 'Leave empty to keep the PIN' : '4–8 digits'} required={!editing} />
          <small className="field-help">Give it to the staff member in person. It is stored only as a hash{editing ? '; a new PIN also lifts a lock-out' : ''}.</small>
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
        {editing && (
          <label className="form-label tech-checkbox">
            <span><input type="checkbox" checked={form.active} onChange={set('active')} /> Active</span>
            <small className="field-help">Inactive staff cannot register partners. Their past registrations stay.</small>
          </label>
        )}
      </div>
      {notice && <div className="notice error" role="alert">{notice}</div>}
      <div className="button-row">
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add staff member'}</button>
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
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
  const [editing, setEditing] = useState(null) // null | 'new' | staff row
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
          <h2>Staff registrations &amp; targets</h2>
          <p className="muted-copy">Partners registered by field staff through the form's Staff mode. A registration counts toward a target once: when it is the first registration of that mobile number and not rejected. Self-registrations never count for staff.</p>
        </div>
        <div className="button-row">
          <button type="button" className="primary-btn" onClick={() => { setEditing('new'); setNotice(null) }}><Icon name="plus" size={15} /> Add staff member</button>
        </div>
      </div>

      {editing && (
        <StaffForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? null : editing} onSaved={saved} onCancel={() => setEditing(null)} />
      )}
      {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}

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
        <EmptyState icon="users" title="No staff members yet" description="Add the field staff who register mechanics and technicians. Each one gets a Staff ID and PIN to use in the form's Staff mode." />
      ) : (
        <>
          <p className="muted-copy" role="status">{rangeLabel} · targets show the current day, week or month{loading ? ' · updating…' : ''}</p>
          <div className="campaign-table-wrap">
            <table className="kyc-table">
              <thead>
                <tr>
                  <th scope="col">Staff member</th>
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
