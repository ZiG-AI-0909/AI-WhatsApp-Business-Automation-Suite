import { useEffect, useState } from 'react'
import Badge from '../components/Badge.jsx'
import EmptyState from '../components/EmptyState.jsx'
import Icon from '../components/Icon.jsx'
import Modal from '../components/Modal.jsx'
import { apiFetch, apiFetchRaw } from '../api.js'
import { friendlyErrorMessage } from '../utils/errorMessages.js'
import { bucketLabel, formatBytes, formatDateTime } from './storageFormat.js'

// Storage → Files (administrators): filter, View / Download each file, and
// delete a selection (some, the whole page, or everything matching the
// filters). Vendor KYC / partner documents and files a pending campaign
// still uses cannot be selected — the server skips them too. Every delete
// needs "DELETE" typed, is logged with who did it, and notifies all
// administrators.

const baseName = (name) => name.split('/').pop()

export default function StorageFiles({ buckets, deletions, onChanged }) {
  const [filters, setFilters] = useState({ bucket: '', type: '', minMb: '', q: '', sort: 'size', page: 1 })
  const [search, setSearch] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState(() => new Map()) // id → { path, sizeBytes|null }
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((current) => (current.q === search.trim() ? current : { ...current, q: search.trim(), page: 1 })), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const filterQuery = new URLSearchParams(Object.entries({ bucket: filters.bucket, type: filters.type, minMb: filters.minMb, q: filters.q, sort: filters.sort })
    .filter(([, value]) => value !== '' && value != null)).toString()
  const query = `${filterQuery}${filterQuery ? '&' : ''}page=${filters.page}&pageSize=25`
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch(`/storage/files?${query}`)
      .then((value) => { if (!cancelled) { setData(value); setError('') } })
      .catch((err) => { if (!cancelled) setError(friendlyErrorMessage(err, { context: 'Stored files' })) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, reload])

  const set = (key) => (event) => { setFilters((current) => ({ ...current, [key]: event.target.value, page: 1 })); setSelected(new Map()) }
  const files = data?.files || []
  const selectable = files.filter((file) => !file.protected && !file.inUse)
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const allOnPage = selectable.length > 0 && selectable.every((file) => selected.has(file.id))
  const knownBytes = [...selected.values()].reduce((sum, item) => sum + (item.sizeBytes || 0), 0)
  const unknownSizes = [...selected.values()].some((item) => item.sizeBytes == null)

  const toggle = (file) => setSelected((current) => {
    const next = new Map(current)
    if (next.has(file.id)) next.delete(file.id); else next.set(file.id, { path: `${file.bucket}/${file.name}`, sizeBytes: file.sizeBytes })
    return next
  })
  const togglePage = (on) => setSelected((current) => {
    const next = new Map(current)
    for (const file of selectable) { if (on) next.set(file.id, { path: `${file.bucket}/${file.name}`, sizeBytes: file.sizeBytes }); else next.delete(file.id) }
    return next
  })
  const selectAllMatching = async () => {
    setBusy('select')
    try {
      const { ids, limit } = await apiFetch(`/storage/files/ids?${filterQuery}`)
      setSelected((current) => {
        const next = new Map(current)
        for (const id of ids) if (!next.has(id)) next.set(id, { path: null, sizeBytes: null })
        return next
      })
      if (ids.length >= limit) setError(`Selected the first ${limit} files; delete them, then select again for the rest.`)
    } catch (err) {
      setError(friendlyErrorMessage(err, { context: 'Select files' }))
    } finally {
      setBusy('')
    }
  }

  const openLink = async (file, mode) => {
    // Open the tab now (browsers block pop-ups opened after an await), then point it at the link.
    const tab = mode === 'view' ? window.open('', '_blank') : null
    try {
      const { url } = await apiFetch(`/storage/files/link?mode=${mode}&bucket=${encodeURIComponent(file.bucket)}&name=${encodeURIComponent(file.name)}`)
      if (tab) { tab.opener = null; tab.location.href = url } else window.location.assign(url)
    } catch (err) {
      tab?.close()
      setError(friendlyErrorMessage(err, { context: mode === 'view' ? 'View file' : 'Download' }))
    }
  }

  const removeSelected = async (event) => {
    event.preventDefault()
    setBusy('delete')
    try {
      const response = await apiFetchRaw('/storage/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected.keys()], confirm: typed }),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value.error || `Could not delete (${response.status}).`)
      setResult(value)
      setSelected(new Map())
      setConfirming(false)
      setTyped('')
      setReload((count) => count + 1)
      onChanged()
    } catch (err) {
      setError(err.message)
      setConfirming(false)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="panel storage-section" aria-labelledby="storage-files-title">
      <header className="storage-section-head">
        <div>
          <h2 id="storage-files-title">Files</h2>
          <p className="muted-copy">View or download any file. Tick files to delete them. To keep a copy while freeing space, use "Download now &amp; clean up" above instead.</p>
        </div>
      </header>

      <div className="kyc-filters storage-filters">
        <label className="form-label">Location
          <select value={filters.bucket} onChange={set('bucket')}>
            <option value="">All</option>
            {buckets.map((bucket) => <option key={bucket} value={bucket}>{bucketLabel(bucket)}</option>)}
          </select>
        </label>
        <label className="form-label">Type
          <select value={filters.type} onChange={set('type')}>
            <option value="">All types</option>
            <option value="pdf">PDF</option>
            <option value="image">Images</option>
            <option value="spreadsheet">Spreadsheets / Office</option>
          </select>
        </label>
        <label className="form-label">Min size
          <select value={filters.minMb} onChange={set('minMb')}>
            <option value="">Any</option>
            <option value="1">1 MB+</option>
            <option value="5">5 MB+</option>
            <option value="20">20 MB+</option>
          </select>
        </label>
        <label className="form-label">Sort
          <select value={filters.sort} onChange={set('sort')}>
            <option value="size">Largest first</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <label className="form-label kyc-filter-search">Search
          <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setSelected(new Map()) }} placeholder="File name or folder" />
        </label>
      </div>

      {error && <div className="notice error" role="alert">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></div>}
      {result && (
        <div className={`notice ${result.skipped.length ? 'warning' : 'success'}`} role="status">
          <strong>{result.deleted.length} file(s) deleted ({formatBytes(result.deletedBytes)} freed).</strong>
          {result.skipped.length > 0 && (
            <>
              {' '}{result.skipped.length} file(s) were kept:
              <ul className="files-skipped">{result.skipped.map((item) => <li key={item.id}>{item.path ? baseName(item.path) : 'A file'} — {item.reason}</li>)}</ul>
            </>
          )}
          <button type="button" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="files-selection-bar" role="region" aria-label="Selected files">
          <span><strong>{selected.size}</strong> file(s) selected{unknownSizes ? '' : ` · ${formatBytes(knownBytes)}`}</span>
          <button type="button" className="ghost-btn" onClick={() => setSelected(new Map())}>Clear selection</button>
          <button type="button" className="danger-btn" onClick={() => { setConfirming(true); setTyped('') }}><Icon name="trash" size={15} /> Delete selected</button>
        </div>
      )}

      {loading && !data ? (
        <div className="muted-copy" role="status">Loading files…</div>
      ) : !files.length ? (
        <EmptyState icon="file" title="No files match" description="Change the filters to see more." />
      ) : (
        <>
          <div className="files-select-tools">
            <label className="check-label">
              <input type="checkbox" checked={allOnPage} disabled={!selectable.length} onChange={(event) => togglePage(event.target.checked)} />
              Select all on this page
            </label>
            {data.total > files.length && (
              <button type="button" className="ghost-btn" disabled={busy === 'select'} onClick={selectAllMatching}>
                {busy === 'select' ? 'Selecting…' : `Select all ${data.total} matching files`}
              </button>
            )}
          </div>
          <div className="campaign-table-wrap">
            <table className="kyc-table storage-files-table">
              <thead>
                <tr>
                  <th scope="col"><span className="visually-hidden">Select</span></th>
                  <th scope="col">File</th><th scope="col">Size</th><th scope="col">Type</th><th scope="col">Modified</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => {
                  const locked = file.protected || file.inUse
                  return (
                    <tr key={file.id} className={selected.has(file.id) ? 'is-selected' : undefined}>
                      <td className="files-check">
                        <input
                          type="checkbox"
                          checked={selected.has(file.id)}
                          disabled={locked}
                          onChange={() => toggle(file)}
                          aria-label={`Select ${baseName(file.name)}`}
                          title={file.protected ? 'Vendor KYC / partner document — use Download now & clean up' : file.inUse ? 'Used by a campaign or schedule that has not finished' : undefined}
                        />
                      </td>
                      <td className="storage-file-name">
                        <span title={file.name}>{baseName(file.name)}</span>
                        <small className="kyc-row-sub">
                          {bucketLabel(file.bucket)}{file.name.includes('/') ? ` · ${file.name.slice(0, file.name.lastIndexOf('/'))}` : ''}
                        </small>
                        {file.protected && <Badge tone="neutral">KYC / partner record</Badge>}
                        {file.inUse && <Badge tone="warning">In use by a campaign</Badge>}
                      </td>
                      <td className="num">{formatBytes(file.sizeBytes)}</td>
                      <td>{file.mimeType || '—'}</td>
                      <td className="num">{formatDateTime(file.updatedAt)}</td>
                      <td className="storage-file-actions">
                        <button type="button" className="ghost-btn" onClick={() => openLink(file, 'view')} aria-label={`View ${baseName(file.name)}`} title="View"><Icon name="eye" size={15} /></button>
                        <button type="button" className="ghost-btn" onClick={() => openLink(file, 'download')} aria-label={`Download ${baseName(file.name)}`} title="Download"><Icon name="download" size={15} /></button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="storage-pager">
            <span className="muted-copy">{data.total} file(s){loading ? ' · updating…' : ''}</span>
            <button type="button" className="secondary-btn" disabled={filters.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>Previous</button>
            <span className="muted-copy">Page {filters.page} of {pages}</span>
            <button type="button" className="secondary-btn" disabled={filters.page >= pages} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Next</button>
          </div>
        </>
      )}

      {deletions?.length > 0 && (
        <details className="storage-details">
          <summary>Recently deleted files — who deleted what</summary>
          <ul className="archive-history">
            {deletions.map((item) => (
              <li key={item.id}>
                <div className="archive-history-head"><strong>{baseName(item.object_name)}</strong><span className="muted-copy">{formatBytes(item.size_bytes)}</span></div>
                <span className="muted-copy">{bucketLabel(item.bucket_id)} · deleted {formatDateTime(item.deleted_at)} by {item.deleted_by_email || 'an administrator'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {confirming && (
        <Modal onClose={() => setConfirming(false)} labelledBy="files-delete-title">
          <form onSubmit={removeSelected} className="files-delete-form">
            <h2 id="files-delete-title">Delete {selected.size} file(s)?</h2>
            <p>{unknownSizes ? 'The selected files' : `${formatBytes(knownBytes)} of files`} will be removed from storage permanently. They are <strong>not</strong> downloaded first — if you might need them, cancel and use "Download now &amp; clean up" instead.</p>
            <p className="muted-copy">Your name is recorded with this deletion and all administrators are notified.</p>
            <label className="form-label">Type DELETE to confirm
              <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} placeholder="DELETE" />
            </label>
            <div className="button-row">
              <button type="button" className="secondary-btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="submit" className="danger-btn" disabled={typed !== 'DELETE' || busy === 'delete'}>{busy === 'delete' ? 'Deleting…' : `Delete ${selected.size} file(s)`}</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  )
}
