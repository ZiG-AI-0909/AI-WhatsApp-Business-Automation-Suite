import { useEffect, useState } from 'react'
import Icon from '../components/Icon.jsx'
import Badge from '../components/Badge.jsx'
import { apiFetch } from '../api.js'
import StorageDonut from './StorageDonut.jsx'
import { formatBytes, formatDateTime, formatPercent, severityMeta, timeAgo } from './storageFormat.js'

// Storage warnings for EVERY signed-in user (the totals are not
// sensitive; file names are never shown here):
//   * StorageBanner — on the dashboard from the early level, on every page
//     at critical/full. Dismissed per level for this browser session only;
//     a higher level shows it again.
//   * StorageCard — the dashboard's "Storage overview" donut.

const DISMISS_KEY = 'sp-storage-banner-dismissed'

function cleanupLine(last) {
  if (!last) return 'No download & clean-up yet'
  return `Last download & clean-up ${timeAgo(last.at)} by ${last.by || 'an administrator'} (${formatBytes(last.bytes)} freed)`
}

export function StorageBanner({ status, onOpenStorage, everywhere = false }) {
  const severity = status?.severity || 0
  const [dismissed, setDismissed] = useState(() => {
    try { return Number(window.sessionStorage.getItem(DISMISS_KEY)) || 0 } catch { return 0 }
  })
  if (!status || !status.configured || severity === 0) return null
  if (everywhere && severity < 3) return null
  if (dismissed >= severity && severity < 4) return null
  const meta = severityMeta(severity)
  const critical = severity >= 3
  const dismiss = () => {
    setDismissed(severity)
    try { window.sessionStorage.setItem(DISMISS_KEY, String(severity)) } catch { /* private mode */ }
  }
  return (
    <div className={`notice ${meta.notice} storage-banner${critical ? ' is-critical' : ''}`} role={critical ? 'alert' : 'status'}>
      <div className="storage-banner-body">
        <strong className="storage-banner-title">
          {critical ? `⚠️ ${severity >= 4 ? 'STORAGE FULL' : 'STORAGE ALMOST FULL'} — ${formatPercent(status.percentUsed)} USED` : `${meta.label}: ${formatPercent(status.percentUsed)} of storage used`}
        </strong>
        <span>{status.message}</span>
        <span className="storage-banner-meta">
          {formatBytes(status.availableBytes)} remaining of {formatBytes(status.capacityBytes)}. {cleanupLine(status.lastCleanup)}.
          {critical && ' An administrator can use Storage → Download now to save older files and free space. Contact your administrator if more storage is required.'}
        </span>
      </div>
      <div className="storage-banner-actions">
        {status.isAdmin && onOpenStorage && <button type="button" className="secondary-btn" onClick={onOpenStorage}><Icon name="layers" size={15} /> Open storage</button>}
        {severity < 4 && <button type="button" className="ghost-btn" onClick={dismiss}>Hide</button>}
      </div>
    </div>
  )
}

export function StorageCard({ status, error, loading, onOpenStorage }) {
  const [history, setHistory] = useState(null)
  useEffect(() => {
    if (!status || status.setupRequired) return
    let cancelled = false
    apiFetch('/storage/notifications?limit=3')
      .then((data) => { if (!cancelled) setHistory(data.notifications || []) })
      .catch(() => { if (!cancelled) setHistory([]) })
    return () => { cancelled = true }
  }, [status?.severity, status?.setupRequired])

  let body
  if (loading && !status) {
    body = <div className="storage-skeleton" role="status">Loading storage…</div>
  } else if (error && !status) {
    body = <div className="notice error" role="alert">Storage status is unavailable right now. {error}</div>
  } else if (status?.setupRequired) {
    body = <p className="muted-copy">{status.isAdmin ? 'Storage monitoring needs a one-time database update: run supabase-storage-monitor-migration.sql in Supabase.' : 'Storage monitoring is not set up yet.'}</p>
  } else if (!status.configured) {
    body = (
      <div className="storage-unset">
        <p><strong>{formatBytes(status.usedBytes)}</strong> used</p>
        <p className="muted-copy">The storage capacity of your plan has not been entered yet, so the percentage and warnings are off. {status.isAdmin ? 'Set it on the Storage page.' : 'An administrator can set it.'}</p>
      </div>
    )
  } else {
    const meta = severityMeta(status.severity)
    body = (
      <>
        <StorageDonut usedBytes={status.usedBytes} capacityBytes={status.capacityBytes} severity={status.severity} compact />
        <p className="storage-card-status">
          <Badge tone={meta.tone} dot>{meta.label}</Badge>
          <span className="muted-copy">{cleanupLine(status.lastCleanup)}</span>
        </p>
      </>
    )
  }

  return (
    <section className="panel storage-card" aria-labelledby="storage-card-title">
      <header className="storage-card-head">
        <div>
          <h2 id="storage-card-title">Storage overview</h2>
          {status?.measuredAt && <p className="muted-copy">Updated {formatDateTime(status.measuredAt)} · {status.exact ? 'measured from Supabase Storage' : 'estimate'}</p>}
        </div>
        {status?.isAdmin && onOpenStorage && <button type="button" className="secondary-btn" onClick={onOpenStorage}>Manage storage</button>}
      </header>
      {body}
      {history?.length > 0 && (
        <div className="storage-history">
          <h3>Recent storage notices</h3>
          <ul>
            {history.map((item) => (
              <li key={item.id}><span className="muted-copy">{formatDateTime(item.created_at)}</span> {item.message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
