import { useEffect, useState } from 'react'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import EmptyState from './components/EmptyState.jsx'

const formatDate = (value) => value ? new Date(value).toLocaleString() : ''

const EMPTY_ITEM = { product: '', size: '', specification: '', quantity: '', unit: '', application: '', notes: '' }

// Document Intelligence — upload a BOQ / project requirement document,
// review the extracted requirement sheet (editable, warnings inline),
// then export an RFQ in Excel or PDF. Past extractions stay available.
export default function DocumentIntelView() {
  const [documents, setDocuments] = useState([])
  const [selected, setSelected] = useState(null)
  const [file, setFile] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState('')

  const load = async () => {
    try {
      setDocuments(await apiFetch('/boq'))
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Document Intelligence' }) })
    }
  }

  useEffect(() => { load() }, [])

  const open = async (id) => {
    setBusy(true)
    try {
      setSelected(await apiFetch(`/boq/${id}`))
      setNotice({ type: '', text: '' })
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Document Intelligence' }) })
    } finally {
      setBusy(false)
    }
  }

  const process = async (event) => {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setNotice({ type: '', text: '' })
    try {
      const formData = new FormData()
      formData.append('file', file)
      const doc = await apiFetch('/boq/process', { method: 'POST', body: formData })
      setSelected(doc)
      setFile(null)
      await load()
      setNotice({ type: 'success', text: `Extracted ${doc.items.length} line item(s) from ${doc.filename}. Review the rows below — warnings are marked inline.` })
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Document Intelligence · extraction' }) })
    } finally {
      setBusy(false)
    }
  }

  const editItem = (index, field, value) => {
    setSelected((current) => ({
      ...current,
      items: current.items.map((item, i) => i === index ? { ...item, [field]: value } : item),
    }))
  }

  const removeItem = (index) => {
    setSelected((current) => ({
      ...current,
      items: current.items.filter((_, i) => i !== index),
    }))
  }

  const addItem = () => {
    setSelected((current) => ({ ...current, items: [...current.items, { ...EMPTY_ITEM }] }))
  }

  const saveReview = async (status) => {
    setBusy(true)
    try {
      const doc = await apiFetch(`/boq/${selected.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selected.items, status }),
      })
      setSelected(doc)
      await load()
      setNotice({ type: 'success', text: status === 'confirmed' ? 'Requirement sheet confirmed. RFQ exports are ready.' : 'Changes saved.' })
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Document Intelligence · save' }) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id) => {
    if (!window.confirm('Delete this processed document and its extracted rows?')) return
    try {
      await apiFetch(`/boq/${id}`, { method: 'DELETE' })
      if (selected?.id === id) setSelected(null)
      await load()
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Document Intelligence' }) })
    }
  }

  // Fetch the export with the auth header (blob download, same pattern as
  // the Image Extractor export — window.location cannot carry the JWT).
  const exportRfq = async (format) => {
    setExporting(format)
    try {
      const response = await apiFetchRaw(`/boq/${selected.id}/export/${format}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Export failed (${response.status})`)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `rfq-${selected.filename.replace(/\.[^.]+$/, '')}.${format === 'excel' ? 'xlsx' : 'pdf'}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'RFQ export' }) })
    } finally {
      setExporting('')
    }
  }

  const warnCount = selected ? selected.warnings.flat().filter((list) => list && list.length).length : 0

  return (
    <div className="view-workspace">
      <div>
        <p className="eyebrow">Requirement to RFQ</p>
        <h2>Document Intelligence</h2>
        <p className="muted-copy">Upload a BOQ or project requirement document (XLSX, DOCX, PDF, TXT, CSV). The AI extracts sizes, quantities, and specifications into an editable requirement sheet, flags likely errors, and produces a ready-to-review RFQ.</p>
      </div>

      {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <section className="panel">
        <form className="form-stack" onSubmit={process}>
          <label className="upload-dropzone">
            {file ? file.name : 'Choose an XLSX, DOCX, PDF, TXT, or CSV document'}
            <small>Text-based documents only — scanned image-only PDFs have no text layer to read.</small>
            <input type="file" accept=".xlsx,.docx,.pdf,.txt,.csv,.md" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
          <div className="button-row">
            <button type="submit" className="primary-btn" disabled={busy || !file}>{busy ? 'Extracting…' : 'Extract requirements'}</button>
          </div>
        </form>
      </section>

      {selected && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Requirement sheet</p>
              <h2>{selected.filename}</h2>
              <span className="file-note">{selected.items.length} items · {warnCount} row(s) with warnings · {formatDate(selected.created_at)}</span>
            </div>
            <div className="button-row">
              <button type="button" className="secondary-btn" onClick={() => exportRfq('excel')} disabled={!!exporting || !selected.items.length}>{exporting === 'excel' ? 'Building…' : 'Export RFQ (Excel)'}</button>
              <button type="button" className="secondary-btn" onClick={() => exportRfq('pdf')} disabled={!!exporting || !selected.items.length}>{exporting === 'pdf' ? 'Building…' : 'Export RFQ (PDF)'}</button>
            </div>
          </div>

          <div className="campaign-table-wrap">
            <table>
              <thead>
                <tr><th>Product</th><th>Size</th><th>Specification</th><th>Quantity</th><th>Unit</th><th>Application</th><th>Notes</th><th /></tr>
              </thead>
              <tbody>
                {selected.items.map((item, index) => {
                  const rowWarnings = selected.warnings?.[index] || []
                  return (
                    <tr key={index} className={rowWarnings.length ? 'row-warnings' : ''}>
                      <td data-label="Product"><input value={item.product} onChange={(event) => editItem(index, 'product', event.target.value)} /></td>
                      <td data-label="Size"><input value={item.size} onChange={(event) => editItem(index, 'size', event.target.value)} /></td>
                      <td data-label="Specification"><input value={item.specification} onChange={(event) => editItem(index, 'specification', event.target.value)} /></td>
                      <td data-label="Quantity"><input value={item.quantity} onChange={(event) => editItem(index, 'quantity', event.target.value)} /></td>
                      <td data-label="Unit"><input value={item.unit} onChange={(event) => editItem(index, 'unit', event.target.value)} /></td>
                      <td data-label="Application"><input value={item.application} onChange={(event) => editItem(index, 'application', event.target.value)} /></td>
                      <td data-label="Notes"><input value={item.notes} onChange={(event) => editItem(index, 'notes', event.target.value)} /></td>
                      <td data-label="Actions">
                        {rowWarnings.length > 0 && (
                          <ul className="warning-list">
                            {rowWarnings.map((warning, wIndex) => <li key={wIndex}>{warning}</li>)}
                          </ul>
                        )}
                        <button type="button" className="danger-btn" onClick={() => removeItem(index)}>Remove</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="button-row" style={{ marginTop: '8px' }}>
              <button type="button" className="secondary-btn" onClick={addItem}>Add row</button>
              <button type="button" className="secondary-btn" onClick={() => saveReview('review')} disabled={busy}>Save changes</button>
              <button type="button" className="primary-btn" onClick={() => saveReview('confirmed')} disabled={busy}>Confirm requirement sheet</button>
            </div>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Processed documents</h2>
          <span className="file-note">{documents.length} saved</span>
        </div>
        <div className="campaign-table-wrap">
          <table>
            <thead>
              <tr><th>Document</th><th>Type</th><th>Items</th><th>Warnings</th><th>Status</th><th>Processed</th><th /></tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td data-label="Document"><strong>{doc.filename}</strong></td>
                  <td data-label="Type">{(doc.file_ext || '').replace('.', '').toUpperCase() || '-'}</td>
                  <td data-label="Items">{(doc.items || []).length}</td>
                  <td data-label="Warnings">{(doc.warnings || []).flat().filter((list) => list && list.length).length}</td>
                  <td data-label="Status"><span className={`campaign-status ${doc.status === 'confirmed' ? 'completed' : 'paused'}`}>{doc.status}</span></td>
                  <td data-label="Processed"><small>{formatDate(doc.created_at)}</small></td>
                  <td data-label="Actions">
                    <div className="button-row">
                      <button type="button" className="secondary-btn" onClick={() => open(doc.id)}>Review</button>
                      <button type="button" className="danger-btn" onClick={() => remove(doc.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!documents.length && (
            <EmptyState
              icon="📋"
              title="No documents processed yet"
              description="Upload a BOQ or requirement file above — extracted sizes, quantities, and standards will appear here as an editable sheet you can export as an RFQ."
            />
          )}
        </div>
      </section>
    </div>
  )
}
