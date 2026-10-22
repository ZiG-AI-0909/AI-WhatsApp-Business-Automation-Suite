import { useCallback, useEffect, useState } from 'react'
import Badge from './components/Badge.jsx'
import Icon from './components/Icon.jsx'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import StorageDonut from './storage/StorageDonut.jsx'
import StorageTrend from './storage/StorageTrend.jsx'
import DownloadCleanup from './storage/DownloadCleanup.jsx'
import StorageFiles from './storage/StorageFiles.jsx'
import { StorageBanner } from './storage/StorageAlerts.jsx'
import { refreshStorageStatus } from './storage/useStorageStatus.js'
import { bucketLabel, formatBytes, formatDateTime, formatPercent, severityMeta } from './storage/storageFormat.js'

// ─────────────────────────────────────────────────────────────────────────────
// Storage management — administrators only (the KYC staff list; the backend
// enforces it on every /api/storage admin route). Usage, warning levels,
// "Download now & clean up", the file list and settings. Nothing is ever
// deleted automatically.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_STATUS = {
  sent: 'Emailed', partial: 'Some emails failed', failed: 'Email failed', not_configured: 'Email not set up', no_recipients: 'No recipients', pending: 'Sending…',
}

function errorText(err, context) {
  return err?.code === 'STORAGE_MIGRATION_PENDING' ? err.message : friendlyErrorMessage(err, { context })
}

function Tile({ label, value, note }) {
  return (
    <div className="storage-tile">
      <span className="storage-tile-label">{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  )
}

// ── Settings ────────────────────────────────────────────────────────────────

// Supabase plan quotas (same as PLANS in backend/src/storage/storageMonitor.js).
const PLANS = {
  free: { label: 'Supabase Free', files: '1 GB', database: '500 MB' },
  pro: { label: 'Supabase Pro', files: '100 GB', database: '8 GB' },
}

function toForm(settings) {
  return {
    plan: PLANS[settings.plan] ? settings.plan : 'custom',
    capacity_gb: settings.capacity_gb ?? '',
    db_capacity_gb: settings.db_capacity_gb ?? '',
    warn_early_pct: settings.warn_early_pct,
    warn_high_pct: settings.warn_high_pct,
    warn_critical_pct: settings.warn_critical_pct,
    reminder_hours: settings.reminder_hours,
    notify_all_staff: settings.notify_all_staff,
    extra_recipient_emails: (settings.extra_recipient_emails || []).join(', '),
  }
}

function SettingsForm({ overview, onSaved }) {
  const [form, setForm] = useState(() => toForm(overview.settings))
  const [errors, setErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setForm(toForm(overview.settings)) }, [overview.settings.updated_at])

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }))
  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    setErrors({})
    try {
      const response = await apiFetchRaw('/storage/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          warn_early_pct: Number(form.warn_early_pct), warn_high_pct: Number(form.warn_high_pct), warn_critical_pct: Number(form.warn_critical_pct),
          reminder_hours: Number(form.reminder_hours),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) { setErrors(data.fields || {}); setNotice({ type: 'error', text: data.error || `Could not save (${response.status}).` }); return }
      setNotice({ type: 'success', text: 'Settings saved. Warnings are re-checked now.' })
      onSaved(data)
    } catch (err) {
      setNotice({ type: 'error', text: errorText(err, 'Save settings') })
    } finally {
      setBusy(false)
    }
  }
  const err = (key) => errors[key] && <p className="kyc-error" role="alert">{errors[key]}</p>

  return (
    <section className="panel storage-section" aria-labelledby="storage-settings-title">
      <header className="storage-section-head"><div><h2 id="storage-settings-title">Settings</h2></div></header>
      <form onSubmit={save} className="storage-settings">
        <fieldset>
          <legend>Capacity</legend>
          <p className="muted-copy">Your Supabase plan sets how much file storage and database space you have. Warnings follow whichever is fuller.</p>
          <label className="form-label storage-plan">Supabase plan
            <select value={form.plan} onChange={set('plan')}>
              {Object.entries(PLANS).map(([key, plan]) => <option key={key} value={key}>{plan.label} — {plan.files} files, {plan.database} database</option>)}
              <option value="custom">Custom (enter the numbers)</option>
            </select>
          </label>
          {form.plan === 'custom' ? (
            <div className="storage-form-grid">
              <label className="form-label">File storage capacity (GB)<input type="number" min="0" step="0.1" inputMode="decimal" value={form.capacity_gb} onChange={set('capacity_gb')} placeholder="e.g. 1 or 100" />{err('capacity_gb')}</label>
              <label className="form-label">Database capacity (GB, optional)<input type="number" min="0" step="0.1" inputMode="decimal" value={form.db_capacity_gb} onChange={set('db_capacity_gb')} placeholder="e.g. 0.5 or 8" />{err('db_capacity_gb')}</label>
            </div>
          ) : (
            <p className="muted-copy">File storage: <strong>{PLANS[form.plan].files}</strong> · Database: <strong>{PLANS[form.plan].database}</strong>. If you upgrade in Supabase, change the plan here too.</p>
          )}
        </fieldset>
        <fieldset>
          <legend>Warning levels</legend>
          <div className="storage-form-grid">
            <label className="form-label">Early warning at (%)<input type="number" min="1" max="99" value={form.warn_early_pct} onChange={set('warn_early_pct')} />{err('warn_early_pct')}</label>
            <label className="form-label">High usage at (%)<input type="number" min="1" max="99" value={form.warn_high_pct} onChange={set('warn_high_pct')} />{err('warn_high_pct')}</label>
            <label className="form-label">Critical at (%)<input type="number" min="1" max="99" value={form.warn_critical_pct} onChange={set('warn_critical_pct')} />{err('warn_critical_pct')}</label>
            <label className="form-label">Repeat the warning every (hours, 0 = never)<input type="number" min="0" max="720" value={form.reminder_hours} onChange={set('reminder_hours')} />{err('reminder_hours')}</label>
          </div>
          <p className="muted-copy">"Storage full" always alerts at 100%. Each level is announced once when it is crossed; again only after the repeat interval, or after usage drops below it and rises again.</p>
        </fieldset>
        <fieldset>
          <legend>Who is alerted</legend>
          <p className="muted-copy">Everyone signed in sees the warning banner. Email (warnings and clean-ups) goes to:</p>
          <label className="check-label"><input type="checkbox" checked={form.notify_all_staff} onChange={set('notify_all_staff')} /> Every storage administrator (KYC staff list)</label>
          <label className="form-label">Extra email addresses (comma separated)<input value={form.extra_recipient_emails} onChange={set('extra_recipient_emails')} placeholder="owner@company.com, it@company.com" />{err('extra_recipient_emails')}</label>
          <p className="muted-copy">
            Sender: {overview.emailSender === 'server' ? 'the server Resend settings.' : overview.emailSender === 'admin_settings' ? 'the Resend settings (Settings → Email) of the administrator who last saved this page.' : 'not set up yet — add your Resend key in Settings → Email, then save this page.'}
          </p>
        </fieldset>
        {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
        <div className="button-row"><button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></div>
      </form>
    </section>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function StorageView() {
  const [overview, setOverview] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (path = '/storage/overview', options) => {
    try {
      const data = await apiFetch(path, options)
      setOverview(data)
      setError('')
      return data
    } catch (err) {
      setError(errorText(err, 'Storage'))
      return null
    }
  }, [])
  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setBusy(true)
    await load('/storage/refresh', { method: 'POST' })
    refreshStorageStatus()
    setBusy(false)
  }

  if (error && !overview) return <div className="view-workspace"><div className="notice error" role="alert">{error}</div></div>
  if (!overview) return <div className="panel muted-copy" role="status">Loading storage…</div>

  const { usage, alert } = overview
  const meta = severityMeta(alert.severity)
  const lastCleaned = overview.archives.find((item) => item.status === 'cleaned')
  const statusForBanner = {
    configured: usage.alert.capacityBytes != null, severity: alert.severity, alert: usage.alert, message: alert.message,
    lastCleanup: lastCleaned ? { at: lastCleaned.cleanedAt, by: lastCleaned.cleanedBy, files: lastCleaned.cleanedFiles, bytes: lastCleaned.cleanedBytes } : null,
  }

  return (
    <div className="view-workspace storage-page">
      <div className="view-toolbar">
        <div>
          <h2>Storage</h2>
          <p className="muted-copy">{usage.provider} · measured {formatDateTime(usage.measuredAt)} from {usage.source}. Exact per-file sizes; your plan's billed figure can differ slightly.</p>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-btn" disabled={busy} onClick={refresh}>
            <Icon name="refresh" size={15} /> {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}
      <StorageBanner status={statusForBanner} />

      <section className="panel storage-section storage-summary" aria-labelledby="storage-summary-title">
        <header className="storage-section-head">
          <div><h2 id="storage-summary-title">Storage overview</h2></div>
          <Badge tone={meta.tone} dot>{usage.capacityBytes ? meta.label : 'Capacity not set'}</Badge>
        </header>
        <div className="storage-summary-grid">
          {usage.capacityBytes
            ? <StorageDonut usedBytes={usage.usedBytes} capacityBytes={usage.capacityBytes} severity={alert.severity} />
            : <div className="notice info">Enter your plan's storage capacity in Settings below to see the chart, percentages and warnings. Used now: <strong>{formatBytes(usage.usedBytes)}</strong>.</div>}
          <div className="storage-tiles">
            <Tile label="Total capacity" value={formatBytes(usage.capacityBytes)} note={usage.capacitySource || 'Not set'} />
            <Tile label="Used" value={formatBytes(usage.usedBytes)} note={`${usage.fileCount} file(s) · ${formatPercent(usage.percentUsed)}`} />
            <Tile label="Remaining" value={formatBytes(usage.availableBytes)} note={usage.percentUsed == null ? '—' : `${formatPercent(100 - usage.percentUsed)} free`} />
            <Tile label="Database" value={formatBytes(usage.database.bytes)} note={usage.database.capacityBytes ? `${formatPercent(usage.database.percentUsed)} of ${formatBytes(usage.database.capacityBytes)}` : 'Records and settings (separate quota)'} />
          </div>
        </div>
        <div className="campaign-table-wrap">
          <table className="kyc-table storage-bucket-table">
            <caption className="visually-hidden">Usage by storage location</caption>
            <thead><tr><th scope="col">Location</th><th scope="col">Files</th><th scope="col">Size</th><th scope="col">Share</th><th scope="col">Access</th></tr></thead>
            <tbody>
              {usage.byBucket.map((item) => (
                <tr key={item.bucket}>
                  <td>{bucketLabel(item.bucket)}<small className="kyc-row-sub">{item.bucket}</small></td>
                  <td className="num">{item.files}</td>
                  <td className="num">{formatBytes(item.bytes)}</td>
                  <td className="num">{usage.usedBytes ? formatPercent((item.bytes / usage.usedBytes) * 100) : '—'}</td>
                  <td>{item.public === false ? <Badge tone="success">Private</Badge> : item.public ? <Badge tone="neutral">Public link</Badge> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel storage-section" aria-labelledby="storage-trend-title">
        <header className="storage-section-head"><div><h2 id="storage-trend-title">Used storage, last 30 days</h2></div></header>
        <StorageTrend points={overview.trend} />
      </section>

      <DownloadCleanup folders={overview.folders} archives={overview.archives} limits={overview.limits} onChanged={() => { load(); refreshStorageStatus() }} />

      <StorageFiles buckets={usage.byBucket.map((item) => item.bucket)} deletions={overview.deletions} onChanged={() => { load(); refreshStorageStatus() }} />

      <SettingsForm overview={overview} onSaved={(data) => { setOverview(data); refreshStorageStatus() }} />

      <section className="panel storage-section" aria-labelledby="storage-history-title">
        <header className="storage-section-head"><div><h2 id="storage-history-title">Notification history</h2></div></header>
        {overview.notifications.length ? (
          <ul className="storage-notifications">
            {overview.notifications.map((item) => (
              <li key={item.id}>
                <span className="muted-copy">{formatDateTime(item.created_at)}</span>
                <span>{item.message}</span>
                <small className={`storage-email is-${item.email_status}`} title={item.email_error || ''}>
                  {EMAIL_STATUS[item.email_status] || item.email_status}{item.email_recipients ? ` (${item.email_recipients})` : ''}
                </small>
              </li>
            ))}
          </ul>
        ) : <p className="muted-copy">No storage notifications yet.</p>}
      </section>
    </div>
  )
}
