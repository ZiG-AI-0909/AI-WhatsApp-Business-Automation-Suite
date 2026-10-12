import { useEffect, useState } from 'react'
import Card from './components/Card'
import Button from './components/Button'
import Badge from './components/Badge'
import EmptyState from './components/EmptyState.jsx'
import { request } from './imageExtractorApi.js'

const listValue = (value) => Array.isArray(value) ? value.join(', ') : value || '-'

// Identify Product — second mode of the Image Extractor. A photo of a
// pipe/product produces an AI SUGGESTION (category, size, readable
// markings) that requires manual verification against official records.
export default function ProductIdentifyView() {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState('')
  const [latest, setLatest] = useState(null)
  const [history, setHistory] = useState([])
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)

  const loadHistory = async () => {
    try {
      setHistory(await request('/identifications'))
    } catch (error) {
      setNotice({ type: 'error', text: friendlyError(error) })
    }
  }

  useEffect(() => { loadHistory() }, [])

  const pick = (event) => {
    const next = event.target.files?.[0]
    setFile(next || null)
    setPreview(next ? URL.createObjectURL(next) : '')
    setLatest(null)
  }

  const identify = async (event) => {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setNotice({ type: '', text: '' })
    try {
      const form = new FormData()
      form.append('image', file)
      const result = await request('/identify', { method: 'POST', body: form })
      setLatest(result)
      await loadHistory()
    } catch (error) {
      setNotice({ type: 'error', text: friendlyError(error) })
    } finally {
      setBusy(false)
    }
  }

  const review = async (id, reviewStatus) => {
    try {
      await request(`/identifications/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_status: reviewStatus }),
      })
      await loadHistory()
      if (latest?.id === id) setLatest({ ...latest, review_status: reviewStatus })
    } catch (error) {
      setNotice({ type: 'error', text: friendlyError(error) })
    }
  }

  const remove = async (id) => {
    try {
      await request(`/identifications/${id}`, { method: 'DELETE' })
      if (latest?.id === id) setLatest(null)
      await loadHistory()
    } catch (error) {
      setNotice({ type: 'error', text: friendlyError(error) })
    }
  }

  return (
    <>
      <section className="panel">
        <form className="form-stack" onSubmit={identify}>
          <label className="upload-dropzone">
            {file ? file.name : 'Drop a JPG, PNG, or WEBP photo of the pipe/product'}
            <small>Markings visible (brand, standard, size printing) give the best suggestions.</small>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} />
          </label>
          {preview && <img className="media-thumb" src={preview} alt="Product preview" style={{ maxWidth: '220px' }} />}
          <div className="button-row">
            <Button variant="primary" onClick={identify} disabled={busy || !file}>{busy ? 'Analyzing photo…' : 'Identify product'}</Button>
          </div>
        </form>
      </section>

      {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      {latest && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">AI suggestion — verify manually</p>
              <h2>{latest.product_category || 'Unknown product'}</h2>
              <span className="file-note">Source: {latest.source_image}</span>
            </div>
            <Badge tone={latest.review_status === 'confirmed' ? 'success' : latest.review_status === 'rejected' ? 'danger' : 'neutral'}>{latest.review_status || 'pending_review'}</Badge>
          </div>
          <div className="settings-grid">
            <div className="copilot-section"><h4>Size</h4><p>{latest.size || 'Not readable — check the product physically'}</p></div>
            <div className="copilot-section"><h4>Specification</h4><p>{latest.specification || 'No standard marking read'}</p></div>
            <div className="copilot-section"><h4>Readable markings</h4><p>{listValue(latest.markings)}</p></div>
            <div className="copilot-section"><h4>What the photo shows</h4><p>{latest.condition_notes || '-'}</p></div>
          </div>
          <p className="muted-copy">AI estimate (confidence {Math.round((latest.confidence || 0) * 100)}%). This is a suggestion only — verify against official product records before relying on it.</p>
          <div className="button-row">
            <Button variant="secondary" onClick={() => review(latest.id, 'confirmed')} disabled={busy}>Confirm as correct</Button>
            <Button variant="secondary" onClick={() => review(latest.id, 'rejected')} disabled={busy}>Reject</Button>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Past identifications</h2>
          <span className="file-note">{history.length} saved</span>
        </div>
        <div className="campaign-table-wrap">
          <table>
            <thead>
              <tr><th>Category (suggested)</th><th>Size</th><th>Specification</th><th>Markings</th><th>Confidence</th><th>Status</th><th>When</th><th /></tr>
            </thead>
            <tbody>
              {history.map((item) => (
                <tr key={item.id}>
                  <td data-label="Category"><strong>{item.product_category || 'Unknown'}</strong><small>{item.source_image}</small></td>
                  <td data-label="Size">{item.size || '-'}</td>
                  <td data-label="Specification">{item.specification || '-'}</td>
                  <td data-label="Markings"><small>{listValue(item.markings)}</small></td>
                  <td data-label="Confidence">{Math.round((item.confidence || 0) * 100)}%</td>
                  <td data-label="Status"><Badge tone={item.review_status === 'confirmed' ? 'success' : item.review_status === 'rejected' ? 'danger' : 'neutral'}>{item.review_status || 'pending_review'}</Badge></td>
                  <td data-label="When"><small>{new Date(item.created_at).toLocaleString()}</small></td>
                  <td data-label="Actions">
                    <div className="button-row">
                      <Button variant="secondary" onClick={() => setLatest(item)}>View</Button>
                      <Button variant="danger" onClick={() => remove(item.id)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!history.length && (
            <EmptyState
              icon="🔧"
              title="No product photos analyzed yet"
              description="Upload a photo of a pipe or fitting above — the AI will suggest its category, size, and any readable markings for you to verify."
            />
          )}
        </div>
      </section>
    </>
  )
}

function friendlyError(error) {
  return error?.message || 'Something went wrong. Please try again.'
}
