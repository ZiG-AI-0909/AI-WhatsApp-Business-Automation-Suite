import { useEffect, useMemo, useState } from 'react'
import Badge from './components/Badge.jsx'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'
import { apiFetchRaw } from './api.js'
import { formatDate } from './kyc/kycForm.js'
import { AREAS, AREA_LABELS } from './team/teamAreas.js'

// ─────────────────────────────────────────────────────────────────────────────
// "Team & access" — super admins only. Every account registered in the app
// is listed by email; a super admin switches on the areas each one may open
// (WhatsApp, Documents, Vendor KYC forms, …) or makes them super admin.
// Everyone works on one company workspace (shown at the top). The server
// checks every request (backend/src/security/teamAccess.js); super admins
// set on the server (SUPER_ADMIN_EMAILS) cannot be changed here.
// ─────────────────────────────────────────────────────────────────────────────

/** JSON request; throws an Error with .fields / .code from the server. */
async function teamRequest(path, { method = 'GET', body } = {}) {
  const response = await apiFetchRaw(`/team${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`)
    error.fields = data.fields || {}
    error.code = data.code
    throw error
  }
  return data
}

function AccessSummary({ account }) {
  if (account.env_super_admin) return <Badge tone="success" dot>Super admin (server)</Badge>
  if (account.super_admin) return <Badge tone="success" dot>Super admin</Badge>
  if (!account.permissions.length) return <Badge tone="neutral">No access</Badge>
  return (
    <span className="team-areas">
      {account.permissions.map((key) => <Badge key={key} tone={key === 'vendor_kyc' || key === 'technicians' ? 'warning' : 'cold'}>{AREA_LABELS[key]}</Badge>)}
    </span>
  )
}

function AreaPicker({ value, onChange, disabled, idPrefix }) {
  const toggle = (key) => onChange(value.includes(key) ? value.filter((item) => item !== key) : [...value, key])
  return (
    <fieldset className="team-picker" disabled={disabled}>
      <legend className="visually-hidden">Areas</legend>
      {AREAS.map((area) => (
        <label key={area.key} className="team-area" htmlFor={`${idPrefix}-${area.key}`}>
          <input id={`${idPrefix}-${area.key}`} type="checkbox" checked={value.includes(area.key)} onChange={() => toggle(area.key)} />
          <span><strong>{area.label}</strong><small>{area.note}</small></span>
        </label>
      ))}
    </fieldset>
  )
}

function SuperAdminToggle({ checked, onChange, disabled, id }) {
  return (
    <label className="team-super" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} />
      <span><strong>Super admin</strong><small>Every area, and can manage Team &amp; access.</small></span>
    </label>
  )
}

// ── Give access by email ────────────────────────────────────────────────────

function AddMember({ onAdded }) {
  const [email, setEmail] = useState('')
  const [permissions, setPermissions] = useState([])
  const [superAdmin, setSuperAdmin] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    if (!superAdmin && !permissions.length) { setError('Choose at least one area, or make them super admin.'); return }
    setBusy(true)
    setError('')
    try {
      const result = await teamRequest('/members', { method: 'POST', body: { email, permissions, is_super_admin: superAdmin } })
      setEmail('')
      setPermissions([])
      setSuperAdmin(false)
      onAdded(result.account.email)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel team-add" onSubmit={submit} aria-labelledby="team-add-title">
      <h3 id="team-add-title">Give access</h3>
      <p className="muted-copy">Enter the email the person signed up with. They must have created an account in this app first.</p>
      <label className="form-label">Registered email
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="off" required />
      </label>
      <SuperAdminToggle id="team-add-super" checked={superAdmin} onChange={setSuperAdmin} />
      <AreaPicker idPrefix="team-add" value={superAdmin ? AREAS.map((area) => area.key) : permissions} onChange={setPermissions} disabled={superAdmin} />
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="button-row">
        <button type="submit" className="primary-btn" disabled={busy}><Icon name="plus" size={15} /> {busy ? 'Saving…' : 'Give access'}</button>
      </div>
    </form>
  )
}

// ── One account ─────────────────────────────────────────────────────────────

function AccountRow({ account, isSelf, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [permissions, setPermissions] = useState(account.permissions)
  const [superAdmin, setSuperAdmin] = useState(account.super_admin)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = account.env_super_admin

  const open = () => {
    setPermissions(account.super_admin ? [] : account.permissions)
    setSuperAdmin(account.super_admin)
    setError('')
    setEditing(true)
  }

  const run = async (request, message) => {
    setBusy(true)
    setError('')
    try {
      await request()
      setEditing(false)
      onSaved(message)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const save = () => run(
    () => teamRequest(`/members/${account.user_id}`, { method: 'PUT', body: { permissions, is_super_admin: superAdmin } }),
    `Saved access for ${account.email}.`,
  )
  const removeAll = () => {
    if (!window.confirm(`Remove all access from ${account.email}? They will see "waiting for access" until someone gives access again.`)) return
    run(() => teamRequest(`/members/${account.user_id}`, { method: 'DELETE' }), `Removed all access from ${account.email}.`)
  }

  return (
    <li className={`panel team-row${editing ? ' is-editing' : ''}`}>
      <div className="team-row-head">
        <div className="team-who">
          <strong>{account.email}</strong>
          <small className="muted-copy">
            {[isSelf && 'You', account.company_owner && 'Company workspace', account.last_sign_in_at ? `Last sign-in ${formatDate(account.last_sign_in_at, { withTime: true })}` : 'Never signed in'].filter(Boolean).join(' · ')}
          </small>
        </div>
        <AccessSummary account={account} />
        {!editing && !locked && <button type="button" className="secondary-btn" onClick={open}>Edit</button>}
      </div>
      {locked && <small className="field-help">Set on the server (SUPER_ADMIN_EMAILS); change it there.</small>}
      {editing && (
        <div className="team-edit">
          <SuperAdminToggle id={`team-super-${account.user_id}`} checked={superAdmin} onChange={setSuperAdmin} disabled={isSelf && account.super_admin} />
          {isSelf && account.super_admin && <small className="field-help">You cannot remove your own super admin access.</small>}
          <AreaPicker idPrefix={`team-${account.user_id}`} value={superAdmin ? AREAS.map((area) => area.key) : permissions} onChange={setPermissions} disabled={superAdmin} />
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="button-row">
            <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="ghost-btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            {!isSelf && (account.super_admin || account.permissions.length > 0) && (
              <button type="button" className="ghost-btn team-remove" onClick={removeAll} disabled={busy}><Icon name="trash" size={15} /> Remove all access</button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

// ── Company workspace ───────────────────────────────────────────────────────

function CompanyWorkspace({ owner, onSaved }) {
  const [changing, setChanging] = useState(false)
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (event) => {
    event.preventDefault()
    if (!window.confirm(`Switch the whole team to the data of ${email}? Everyone will see that account's WhatsApp, contacts, campaigns and documents from their next page load.`)) return
    setBusy(true)
    setError('')
    try {
      const result = await teamRequest('/company', { method: 'PUT', body: { email } })
      setChanging(false)
      setEmail('')
      onSaved(`The team now works on the data of ${result.account.email}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel team-company" aria-labelledby="team-company-title">
      <div className="team-row-head">
        <div className="team-who">
          <h3 id="team-company-title">Company workspace</h3>
          <small className="muted-copy">Everyone with access works on this account's data. Its WhatsApp connection and API keys can only be changed by signing in as it.</small>
        </div>
        <strong className="team-company-email">{owner?.email || 'Not set'}</strong>
        {!changing && <button type="button" className="ghost-btn" onClick={() => setChanging(true)}>Change</button>}
      </div>
      {!owner && <div className="notice warning">No company workspace yet: the first SUPER_ADMIN_EMAILS account has not signed up. Sign up with it, or choose an account here.</div>}
      {changing && (
        <form className="team-company-form" onSubmit={save}>
          <label className="form-label">Registered email of the company account
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="office@example.com" />
          </label>
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="button-row">
            <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Use this account'}</button>
            <button type="button" className="ghost-btn" onClick={() => setChanging(false)} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  )
}

// ── View ────────────────────────────────────────────────────────────────────

export default function TeamAccessView({ selfEmail }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    teamRequest('')
      .then((result) => { if (!cancelled) { setData(result); setError('') } })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [reload])

  const saved = (message) => { setNotice(message); setReload((value) => value + 1) }

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (data?.accounts || []).filter((account) => {
      if (needle && !account.email.toLowerCase().includes(needle)) return false
      if (filter === 'access') return account.super_admin || account.permissions.length > 0
      if (filter === 'none') return !account.super_admin && !account.permissions.length
      return true
    })
  }, [data, search, filter])
  const waiting = (data?.accounts || []).filter((account) => !account.super_admin && !account.permissions.length).length

  return (
    <div className="view-workspace team-view">
      <div className="view-toolbar">
        <div>
          <h2>Team &amp; access</h2>
          <p className="muted-copy">Choose which parts of the app each person can open. New accounts get no access until you give it here. The server checks every request, so a hidden page cannot be reached another way.</p>
        </div>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}

      {!data && !error ? <div className="panel muted-copy" role="status">Loading the team…</div> : data && (
        <>
          <CompanyWorkspace owner={data.company_owner} onSaved={saved} />
          <AddMember onAdded={(email) => saved(`Gave access to ${email}.`)} />

          <section className="team-list-section" aria-labelledby="team-list-title">
            <h3 id="team-list-title">Registered accounts ({data.accounts.length}){waiting ? ` · ${waiting} waiting for access` : ''}</h3>
            <div className="panel kyc-filters" role="group" aria-label="Find an account">
              <label className="form-label kyc-filter-search">Search
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Email" />
              </label>
              <label className="form-label">Show
                <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="all">Everyone</option>
                  <option value="access">With access</option>
                  <option value="none">Waiting for access</option>
                </select>
              </label>
            </div>
            {!rows.length ? (
              <EmptyState icon="users" title="No accounts match" description="Change the search or the filter." />
            ) : (
              <ul className="team-list">
                {rows.map((account) => (
                  <AccountRow key={`${account.user_id}-${account.updated_at}-${account.permissions.join()}-${account.super_admin}`} account={account} isSelf={account.email === String(selfEmail || '').toLowerCase()} onSaved={saved} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
