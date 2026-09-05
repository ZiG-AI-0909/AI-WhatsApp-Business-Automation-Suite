import { useEffect, useState } from 'react';
import Card from './components/Card';
import Button from './components/Button';
import Badge from './components/Badge';

const BACKEND_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')
const API = `${BACKEND_URL}/api/image-extractor`

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data
}

const listValue = (value) => Array.isArray(value) ? value.join(', ') : value || '-'
const MAX_FILES = 100
const WORKERS = 3

const groupLeads = (leads) => {
  const groups = new Map()
  for (const lead of leads) {
    const key = lead.extraction_group_id || `${lead.source_image}-${lead.created_at}`
    if (!groups.has(key)) groups.set(key, { id: key, source_image: lead.source_image, leads: [] })
    groups.get(key).leads.push(lead)
  }
  return [...groups.values()]
}

export default function ImageExtractorView() {
  const [files, setFiles] = useState([])
  const [leads, setLeads] = useState([])
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })

  const load = async () => {
    try {
      const nextLeads = await request('/leads')
      setLeads(nextLeads)
      setSelectedIds(current => {
        const pendingIds = new Set(nextLeads
          .filter(lead => (lead.review_status || 'pending_review') === 'pending_review')
          .map(lead => lead.id))
        const nextSelected = new Set([...current].filter(id => pendingIds.has(id)));

        return nextSelected.size === current.size ? current : nextSelected
      })
    } catch (error) { setNotice({ type: 'error', text: error.message }) }
  }

  useEffect(() => { load() }, [])

  const pendingLeads = leads.filter(lead => (lead.review_status || 'pending_review') === 'pending_review')
  const allPendingSelected = pendingLeads.length > 0 && pendingLeads.every(lead => selectedIds.has(lead.id))

  const toggleSelection = (id) => setSelectedIds(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const toggleSelectAll = () => setSelectedIds(current => {
    if (allPendingSelected) return new Set()
    return new Set(pendingLeads.map(lead => lead.id))
  })

  const bulkReview = async (reviewStatus) => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (reviewStatus === 'confirmed' && ids.length > 3) {
      const message = `You're about to confirm ${ids.length} leads without individually reviewing each one. This data came from AI extraction and may contain errors. Proceed?`
      if (!window.confirm(message)) return
    }
    setBulkBusy(true)
    try {
      const result = await request('/leads/bulk-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, review_status: reviewStatus }),
      })
      setSelectedIds(new Set())
      await load()
      setNotice({ type: 'success', text: `${result.updated_count} lead(s) marked ${reviewStatus}.` })
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
    } finally {
      setBulkBusy(false)
    }
  }

  const addFiles = (incoming) => setFiles(current => [...current, ...Array.from(incoming)
    .filter(file => /image\/(jpeg|png|webp)/i.test(file.type))
    .map(file => ({ file, status: 'queued' }))].slice(0, MAX_FILES))

  const process = async () => {
    const pending = files.map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'queued' || item.status === 'failed')
    if (!pending.length) return setNotice({ type: 'error', text: 'There are no queued images to process.' })
    setBusy(true)
    setNotice({ type: '', text: '' })
    let cursor = 0
    let completed = 0
    let failed = 0
    const queue = pending
    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor++
        const { item, index: itemIndex } = queue[index]
        setFiles(current => current.map((entry, currentIndex) => currentIndex === itemIndex ? { ...entry, status: 'processing' } : entry))
        try {
          const form = new FormData()
          form.append('image', item.file)
          const result = await request('/process-one', { method: 'POST', body: form })
          if (result.result.processing_status === 'failed') failed += 1
          else completed += 1
          setFiles(current => current.map((entry, currentIndex) => currentIndex === itemIndex
            ? { ...entry, status: result.result.processing_status, error: result.result.error }
            : entry))
        } catch (error) {
          failed += 1
          setFiles(current => current.map((entry, currentIndex) => currentIndex === itemIndex ? { ...entry, status: 'failed', error: error.message } : entry))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker))
    await load()
    setBusy(false)
    setNotice({ type: failed ? 'error' : 'success', text: `${completed} image(s) processed${failed ? `, ${failed} failed` : ''}.` })
  }

  const remove = async (id) => {
    try { await request(`/leads/${id}`, { method: 'DELETE' }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) }
  }

  const deleteAll = async () => {
    if (!leads.length) return
    const confirmed = window.confirm(`Are you sure you want to delete all ${leads.length} lead(s)? This action cannot be undone.`)
    if (!confirmed) return
    setBulkBusy(true)
    try {
      await request('/leads/all', { method: 'DELETE' })
      setSelectedIds(new Set())
      await load()
      setNotice({ type: 'success', text: 'All extracted leads have been deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: error.message || 'Failed to delete all leads.' })
    } finally {
      setBulkBusy(false)
    }
  }

  const exportData = (format, all = true) => {
    window.location.href = `${API}/export/${format}${all ? '?all=true' : ''}`
  }

  const pasteImage = (event) => {
    const images = Array.from(event.clipboardData?.files || [])
    if (images.length) {
      event.preventDefault()
      addFiles(images)
    }
  }

  return (
    <div className="view-workspace">
      <div>
        <p className="eyebrow">Image to structured data</p>
        <h2>Lead Image Extractor</h2>
        <p className="muted-copy">Upload business cards, listing screenshots, or directory images. NVIDIA Vision captures every readable value.</p>
      </div>

      {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <section className="panel">
        <label
          className="upload-dropzone"
          tabIndex="0"
          onPaste={pasteImage}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            addFiles(event.dataTransfer.files)
          }}
        >
          {files.length ? `${files.length} image(s) queued` : 'Drop JPG, PNG, or WEBP images here'}
          <small>or paste images here with Ctrl+V (up to {MAX_FILES})</small>
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => addFiles(event.target.files)} />
        </label>

        {files.length > 0 && (
          <>
            <div className="button-row">
              {files.map((item, index) => (
                <span className={`tag image-queue-item ${item.status}`} key={`${item.file.name}-${index}`}>
                  <span title={item.error || item.file.name}>{item.file.name} <small>{item.status}</small></span>
                  {!busy && <button type="button" onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))}>x</button>}
                </span>
              ))}
              <Button variant="primary" onClick={process} disabled={busy || !files.some(item => item.status === 'queued' || item.status === 'failed')}>{busy ? 'Processing queue...' : 'Process queue'}</Button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Extracted data ({leads.length})</h2>
          <div className="button-row" style={{ flexWrap: 'wrap', gap: '8px' }}>
            <label className="checkbox-label">
              <input type="checkbox" checked={allPendingSelected} onChange={toggleSelectAll} disabled={!pendingLeads.length || bulkBusy} />
              Select All ({pendingLeads.length} pending)
            </label>
            <Button variant="secondary" onClick={() => bulkReview('confirmed')} disabled={!selectedIds.size || bulkBusy}>Confirm Selected</Button>
            <Button variant="secondary" onClick={() => bulkReview('rejected')} disabled={!selectedIds.size || bulkBusy}>Reject Selected</Button>
            <Button variant="secondary" onClick={() => exportData('excel', true)} disabled={!leads.length}>Export All (Excel)</Button>
            <Button variant="secondary" onClick={() => exportData('csv', true)} disabled={!leads.length}>Export All (CSV)</Button>
            <Button variant="danger" onClick={deleteAll} disabled={!leads.length || bulkBusy}>Delete All</Button>
          </div>
        </div>

        {groupLeads(leads).map((group) => (
          <Card key={group.id} className="mb-4" style={{ background: 'rgba(255,255,255,0.65)' }}>
            <div className="panel-header">
              <h3>{group.leads.length} lead{group.leads.length === 1 ? '' : 's'} found in this image</h3>
              <small className="file-note">{group.source_image}</small>
            </div>

            <div className="campaign-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Business</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th>Website</th>
                    <th>Address</th>
                    <th>All visible text</th>
                    <th>Confidence</th>
                    <th>Review</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {group.leads.map(lead => (
                    <tr key={lead.id}>
                      <td>
                        {(lead.review_status || 'pending_review') === 'pending_review' && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${lead.business_name || `lead ${lead.id}`}`}
                            checked={selectedIds.has(lead.id)}
                            onChange={() => toggleSelection(lead.id)}
                            disabled={bulkBusy}
                          />
                        )}
                      </td>
                      <td><strong>{lead.business_name || '(no business name visible)'}</strong><small>{lead.source_image}</small></td>
                      <td>{listValue(lead.phone_numbers)}</td>
                      <td>{listValue(lead.emails)}</td>
                      <td>{lead.website ? <a href={lead.website} target="_blank" rel="noreferrer">Visit</a> : '-'}</td>
                      <td>{lead.address || '-'}</td>
                      <td><small style={{ whiteSpace: 'pre-wrap', maxWidth: '260px' }}>{lead.raw_text || '-'}</small></td>
                      <td>{Math.round((lead.confidence || 0) * 100)}%</td>
                      <td><Badge tone={lead.review_status === 'confirmed' ? 'success' : lead.review_status === 'rejected' ? 'danger' : 'neutral'}>{lead.review_status || 'pending_review'}</Badge></td>
                      <td>
                        <div className="button-row">
                          <Button variant="secondary" onClick={async () => { await request(`/leads/${lead.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review_status: 'confirmed' }) }); await load() }}>Confirm</Button>
                          <Button variant="secondary" onClick={async () => { await request(`/leads/${lead.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review_status: 'rejected' }) }); await load() }}>Reject</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}

        <div className="campaign-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Website</th>
                <th>Address</th>
                <th>All visible text</th>
                <th>Confidence</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leads.map(lead => (
                <tr key={lead.id}>
                  <td><strong>{lead.business_name || '-'}</strong><small>{lead.source_image}</small></td>
                  <td>{listValue(lead.phone_numbers)}</td>
                  <td>{listValue(lead.emails)}</td>
                  <td>{lead.website ? <a href={lead.website} target="_blank" rel="noreferrer">Visit</a> : '-'}</td>
                  <td>{lead.address || '-'}</td>
                  <td><small style={{ whiteSpace: 'pre-wrap', maxWidth: '260px' }}>{lead.raw_text || '-'}</small></td>
                  <td>{Math.round((lead.confidence || 0) * 100)}%</td>
                  <td>{lead.review_status || 'pending_review'}</td>
                  <td><Button variant="danger" onClick={() => remove(lead.id)}>Delete</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!leads.length && <div className="empty-preview">No extracted leads yet.</div>}
        </div>
      </section>
    </div>
  )
}
