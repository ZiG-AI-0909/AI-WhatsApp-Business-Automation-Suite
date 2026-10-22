import { useMemo, useState } from 'react'
import Badge from '../components/Badge.jsx'
import Icon from '../components/Icon.jsx'
import { apiFetchRaw } from '../api.js'
import { crc32, crcHex } from './crc32.js'
import { bucketLabel, formatBytes, formatDateTime } from './storageFormat.js'

// "Download now + clean up" (administrators):
//   1. tick folders (optionally only files older than N days) → Prepare
//   2. Download now — the ZIP streams with a progress bar; when it has
//      fully arrived the browser saves it and reports its size + CRC-32,
//      and the server confirms it matches what it sent
//   3. tick "I have saved the ZIP" → Clean up: exactly those files are
//      removed from storage (files still used by a pending campaign, or
//      changed since the download, stay)
// Every step records who did it; the history below shows it to everyone
// who can open this page, and a clean-up also notifies all administrators.

const STATUS = {
  ready: { label: 'Prepared', tone: 'neutral' },
  downloaded: { label: 'Downloaded', tone: 'cold' },
  verified: { label: 'Download confirmed', tone: 'success' },
  cleaned: { label: 'Cleaned up', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, code: data.code })
  return data
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function Who({ label, email, at }) {
  if (!email && !at) return null
  return <span className="archive-who"><span className="muted-copy">{label}</span> {email || 'an administrator'}{at ? <span className="muted-copy"> · {formatDateTime(at)}</span> : null}</span>
}

export default function DownloadCleanup({ folders, archives, limits, onChanged }) {
  const [selected, setSelected] = useState(() => new Set())
  const [olderThanDays, setOlderThanDays] = useState('')
  const [archive, setArchive] = useState(null)
  const [progress, setProgress] = useState(null) // { received, total }
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState(null)

  const key = (folder) => `${folder.bucket}|${folder.folder}`
  const groups = useMemo(() => {
    const map = new Map()
    for (const folder of folders) {
      if (!map.has(folder.bucket)) map.set(folder.bucket, [])
      map.get(folder.bucket).push(folder)
    }
    return [...map.entries()]
  }, [folders])
  const chosen = folders.filter((folder) => selected.has(key(folder)))
  const chosenBytes = chosen.reduce((sum, folder) => sum + folder.bytes, 0)
  const chosenFiles = chosen.reduce((sum, folder) => sum + folder.files, 0)

  const toggle = (folder) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(key(folder))) next.delete(key(folder)); else next.add(key(folder))
    return next
  })
  const toggleBucket = (list, on) => setSelected((current) => {
    const next = new Set(current)
    for (const folder of list) { if (on) next.add(key(folder)); else next.delete(key(folder)) }
    return next
  })

  const run = async (name, fn) => {
    setBusy(name)
    setNotice(null)
    try {
      await fn()
    } catch (error) {
      setNotice({ type: 'error', text: error.message || 'Something went wrong.' })
    } finally {
      setBusy('')
    }
  }

  const prepare = () => run('prepare', async () => {
    const data = await readJson(await apiFetchRaw('/storage/archives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders: chosen.map(({ bucket, folder }) => ({ bucket, folder })), olderThanDays: olderThanDays === '' ? null : Number(olderThanDays) }),
    }))
    setArchive(data)
    setSaved(false)
    setProgress(null)
  })

  const download = () => run('download', async () => {
    const response = await apiFetchRaw(`/storage/archives/${archive.id}/download`)
    if (!response.ok || !response.body) await readJson(response)
    const total = Number(response.headers.get('content-length')) || 0
    const reader = response.body.getReader()
    const chunks = []
    let received = 0
    let crc = 0
    setProgress({ received: 0, total })
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      crc = crc32(value, crc)
      setProgress({ received, total })
    }
    if (total && received !== total) throw new Error('The download stopped before it finished. Nothing will be removed; download it again.')
    saveBlob(new Blob(chunks, { type: 'application/zip' }), archive.name)
    // Ask the server to confirm we got exactly what it sent.
    const verified = await readJson(await apiFetchRaw(`/storage/archives/${archive.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: received, crc32: crcHex(crc) }),
    }))
    setArchive(verified)
    setNotice({ type: 'success', text: `Downloaded and checked: ${archive.name} (${formatBytes(received)}) arrived complete. Check it is in your Downloads folder, move it somewhere safe, then clean up.` })
    onChanged()
  })

  const cleanup = () => run('cleanup', async () => {
    const data = await readJson(await apiFetchRaw(`/storage/archives/${archive.id}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSaved: true }),
    }))
    setArchive(data)
    setSelected(new Set())
    setNotice({ type: 'success', text: `Cleaned up: ${data.cleanedFiles} file(s) removed (${formatBytes(data.cleanedBytes)} freed).${data.counts.kept ? ` ${data.counts.kept} file(s) were kept — see below.` : ''} All administrators were notified.` })
    onChanged()
  })

  const cancel = () => run('cancel', async () => {
    await readJson(await apiFetchRaw(`/storage/archives/${archive.id}/cancel`, { method: 'POST' }))
    setArchive(null)
    setProgress(null)
    onChanged()
  })

  const percent = progress?.total ? Math.round((progress.received / progress.total) * 100) : null

  return (
    <section className="panel storage-section" aria-labelledby="storage-archive-title">
      <header className="storage-section-head">
        <div>
          <h2 id="storage-archive-title">Download now &amp; clean up</h2>
          <p className="muted-copy">Download folders as one ZIP. After it has fully arrived and you confirm it is saved, exactly those files are removed from storage. Everything not in the ZIP stays.</p>
        </div>
      </header>

      {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      {!archive || archive.status === 'cleaned' || archive.status === 'cancelled' ? (
        <>
          {archive?.status === 'cleaned' && archive.kept.length > 0 && (
            <details className="storage-details" open>
              <summary>Files kept in storage ({archive.counts.kept})</summary>
              <ul className="storage-failures">{archive.kept.map((item) => <li key={item.path}><strong>{item.path}</strong><span>{item.note}</span></li>)}</ul>
            </details>
          )}
          <div className="archive-folders">
            {groups.map(([bucket, list]) => {
              const allOn = list.every((folder) => selected.has(key(folder)))
              return (
                <fieldset key={bucket} className="archive-group">
                  <legend>
                    <label className="check-label"><input type="checkbox" checked={allOn} onChange={(event) => toggleBucket(list, event.target.checked)} /> <strong>{bucketLabel(bucket)}</strong></label>
                  </legend>
                  <ul>
                    {list.map((folder) => (
                      <li key={key(folder)}>
                        <label className="check-label archive-folder">
                          <input type="checkbox" checked={selected.has(key(folder))} onChange={() => toggle(folder)} />
                          <span className="archive-folder-name">{folder.label}</span>
                          <span className="muted-copy">{folder.files} file(s) · {formatBytes(folder.bytes)} · newest {formatDateTime(folder.newest).split(',')[0]}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )
            })}
            {!groups.length && <p className="muted-copy">Storage is empty.</p>}
          </div>
          <div className="archive-actions">
            <label className="form-label">Only files older than (days, optional)
              <input type="number" min="0" max="3650" inputMode="numeric" value={olderThanDays} onChange={(event) => setOlderThanDays(event.target.value)} placeholder="e.g. 90" />
            </label>
            <p className="muted-copy">Selected: {chosen.length} folder(s), {chosenFiles} file(s), {formatBytes(chosenBytes)}{olderThanDays ? ' before the "older than" filter' : ''}. Up to {limits.maxFiles} files / {formatBytes(limits.maxBytes)} per download.</p>
            <button type="button" className="primary-btn" disabled={!chosen.length || Boolean(busy)} onClick={prepare}>
              <Icon name="download" size={15} /> {busy === 'prepare' ? 'Preparing…' : 'Prepare download'}
            </button>
          </div>
        </>
      ) : (
        <div className="archive-current">
          <dl className="kyc-facts">
            <div><dt>ZIP file</dt><dd>{archive.name}</dd></div>
            <div><dt>Contents</dt><dd>{archive.fileCount} file(s) · {formatBytes(archive.totalBytes)}</dd></div>
            <div><dt>Status</dt><dd><Badge tone={STATUS[archive.status]?.tone} dot>{STATUS[archive.status]?.label}</Badge></dd></div>
            <div><dt>Prepared by</dt><dd>{archive.createdBy || '—'}</dd></div>
          </dl>
          {archive.inUseFiles > 0 && <div className="notice info">{archive.inUseFiles} file(s) are still used by a campaign or schedule that has not finished. They are included in the ZIP but will stay in storage.</div>}

          {progress && archive.status !== 'verified' && (
            <div className="archive-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-label="Download progress">
              <span style={{ width: `${percent ?? 0}%` }} />
              <small>{formatBytes(progress.received)}{progress.total ? ` of ${formatBytes(progress.total)} (${percent}%)` : ''}</small>
            </div>
          )}

          <div className="button-row">
            <button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={download}>
              <Icon name="download" size={15} /> {busy === 'download' ? 'Downloading…' : archive.status === 'verified' ? 'Download again' : 'Download now'}
            </button>
            {archive.status !== 'verified' && <button type="button" className="ghost-btn" disabled={Boolean(busy)} onClick={cancel}>Cancel</button>}
          </div>

          {archive.status === 'verified' && (
            <div className="archive-cleanup">
              <div className="notice success">The ZIP arrived complete and matches what was sent (confirmed by {archive.verifiedBy || 'you'}).</div>
              <label className="check-label archive-confirm">
                <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
                <span>I have saved <strong>{archive.name}</strong> somewhere safe (computer, external drive or company cloud). I understand the files will be removed from storage and this ZIP will be the only copy.</span>
              </label>
              <div className="button-row">
                <button type="button" className="danger-btn" disabled={!saved || Boolean(busy)} onClick={cleanup}>
                  <Icon name="trash" size={15} /> {busy === 'cleanup' ? 'Cleaning up…' : `Clean up ${archive.fileCount - (archive.inUseFiles || 0)} file(s)`}
                </button>
                <button type="button" className="ghost-btn" disabled={Boolean(busy)} onClick={cancel}>Not now</button>
              </div>
            </div>
          )}
        </div>
      )}

      {archives.length > 0 && (
        <details className="storage-details" open>
          <summary>Download history — who downloaded and cleaned up what</summary>
          <ul className="archive-history">
            {archives.map((item) => (
              <li key={item.id}>
                <div className="archive-history-head">
                  <strong>{item.name}</strong>
                  <Badge tone={STATUS[item.status]?.tone} dot>{STATUS[item.status]?.label || item.status}</Badge>
                </div>
                <span className="muted-copy">{item.fileCount} file(s) · {formatBytes(item.totalBytes)}{item.status === 'cleaned' ? ` · ${item.cleanedFiles} removed (${formatBytes(item.cleanedBytes)})${item.keptFiles ? `, ${item.keptFiles} kept` : ''}` : ''}</span>
                <div className="archive-whos">
                  <Who label="Prepared by" email={item.createdBy} at={item.createdAt} />
                  <Who label={item.downloadCount > 1 ? `Downloaded (${item.downloadCount}×), last by` : 'Downloaded by'} email={item.downloadedBy} at={item.downloadedAt} />
                  <Who label="Confirmed by" email={item.verifiedBy} at={item.verifiedAt} />
                  <Who label="Cleaned up by" email={item.cleanedBy} at={item.cleanedAt} />
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
