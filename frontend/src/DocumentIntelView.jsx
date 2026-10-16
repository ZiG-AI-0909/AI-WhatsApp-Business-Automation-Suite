import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage, isTechnicalError } from './utils/errorMessages.js'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'
import QuotationView from './QuotationView.jsx'
import BoqUpload from './boq/BoqUpload.jsx'
import BoqCheck from './boq/BoqCheck.jsx'
import BoqDone from './boq/BoqDone.jsx'
import { rowStatus } from './boq/boqReview.js'

const formatDate = (value) => value ? new Date(value).toLocaleString() : ''

// What to restore after a page refresh (this browser tab only): the open
// BOQ, the open quotation and a BOQ that was still being read. The file
// itself is never stored. Storage may be unavailable (private mode).
const SESSION_KEY = 'sp-boq-session'
function readSession() {
  try { return JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || 'null') || {} } catch { return {} }
}
function writeSession(changes) {
  try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...readSession(), ...changes })) } catch { /* storage unavailable */ }
}
const rememberQuote = (quoteId) => writeSession({ quoteId: quoteId ?? null })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DISCARD_QUESTION = 'You have a change in the row you are checking that is not saved yet. Leave it without saving?'

const STEPS = [
  { id: 'upload', label: 'Upload' },
  { id: 'check', label: 'Check' },
  { id: 'use', label: 'Use' },
]

// One plain sentence: where am I and what do I do next.
function nextSentence(step, doc, extracting) {
  if (extracting) return 'We are reading your BOQ. A scanned PDF takes up to about 2 minutes.'
  if (step === 'upload') return 'Choose the BOQ file (PDF, Excel or Word) and press "Read this BOQ".'
  if (step === 'use') return 'The BOQ is confirmed. Create the quotation or download the RFQ.'
  const items = doc?.items || []
  const fix = items.filter((item) => rowStatus(item) === 'fix').length
  const glance = items.filter((item) => rowStatus(item) === 'glance').length
  if (fix) return `Fix the ${fix} ${fix === 1 ? 'item' : 'items'} with wrong numbers (red), then confirm the BOQ.`
  if (glance) return `No wrong numbers. Glance at the ${glance} amber ${glance === 1 ? 'row' : 'rows'} or accept them all, then confirm.`
  return 'Everything checks out. Press "Confirm BOQ".'
}

function StepHeader({ step, doc, extracting, onUploadAnother }) {
  const current = STEPS.findIndex((entry) => entry.id === step)
  return (
    <div className="boq-steps-wrap">
      <ol className="boq-steps" aria-label="BOQ steps">
        {STEPS.map((entry, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'todo'
          return (
            <li key={entry.id} className={`boq-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="boq-step-dot" aria-hidden="true">{state === 'done' ? <Icon name="check" size={14} /> : index + 1}</span>
              <span className="boq-step-label">{entry.label}<span className="visually-hidden">{state === 'done' ? ' (done)' : state === 'current' ? ' (you are here)' : ''}</span></span>
            </li>
          )
        })}
      </ol>
      <p className="boq-next" role="status"><Icon name="info" size={17} /> {nextSentence(step, doc, extracting)}</p>
      {step !== 'upload' && !extracting && (
        <button type="button" className="ghost-btn boq-upload-another" onClick={onUploadAnother}><Icon name="upload" size={16} /> Upload another BOQ</button>
      )}
    </div>
  )
}

// Document Intelligence — 1 Upload a BOQ, 2 Check the rows against the scan,
// 3 Use it (quotation / RFQ). Past BOQs stay available below.
// App.jsx keeps this view mounted (hidden) while other tabs are open, so
// an upload keeps running and nothing typed here is lost on a tab change.
// active: this tab is showing; onActivity('reading' | 'ready' | 'failed' |
// null) drives the sidebar badge while the user is elsewhere.
export default function DocumentIntelView({ active = true, onActivity }) {
  const [documents, setDocuments] = useState([])
  const [selected, setSelected] = useState(null)
  const [file, setFile] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [uploadError, setUploadError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [exporting, setExporting] = useState('')
  const [progress, setProgress] = useState(null)
  const [openedQuote, setOpenedQuote] = useState(null)
  // The scanned PDF, opened in the browser only (never stored server-side),
  // so each row can be shown next to its place on the scan.
  const [scan, setScan] = useState(null)
  const [creatingQuote, setCreatingQuote] = useState(false)
  const activeExtraction = useRef(null)
  const quotationRef = useRef(null)
  const scanRef = useRef(null)
  const activeRef = useRef(active)
  const boqDirtyRef = useRef(false)
  const quoteDirtyRef = useRef(false)
  const [resumed, setResumed] = useState(null) // { name, size } of a BOQ read before a refresh
  // Read once, before any effect writes to it: what this tab had open before a refresh.
  const [savedSession] = useState(readSession)
  const restoredQuoteId = savedSession.quoteId || null

  const load = async () => {
    try {
      setDocuments(await apiFetch('/boq'))
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Document Intelligence' }) })
    }
  }

  useEffect(() => { writeSession({ docId: selected?.id ?? null }) }, [selected?.id])
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => () => scanRef.current?.handle?.close(), [])
  // A refresh or closing the tab would lose typed changes or stop a BOQ
  // that is being read: the browser asks first.
  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (!activeExtraction.current && !boqDirtyRef.current && !quoteDirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const report = (outcome) => onActivity?.(activeRef.current ? null : outcome)
  const confirmDiscard = () => !boqDirtyRef.current || window.confirm(DISCARD_QUESTION)

  const attachScan = async (pdfFile, docId) => {
    try {
      // Loaded on demand: only needed when a scanned PDF is open.
      const { openScan } = await import('./boq/pdfScan.js')
      const handle = await openScan(pdfFile)
      if (!handle) {
        setNotice({ type: 'error', text: `"${pdfFile.name}" does not look like a PDF.` })
        return
      }
      scanRef.current?.handle?.close()
      scanRef.current = { docId, handle, name: pdfFile.name }
      setScan(scanRef.current)
    } catch {
      setNotice({ type: 'error', text: 'This PDF could not be opened here. You can still check the rows by their page number.' })
    }
  }

  const open = async (id, { restoring = false } = {}) => {
    if (!restoring && selected && selected.id !== id && !confirmDiscard()) return
    setBusy(true)
    try {
      setSelected(await apiFetch(`/boq/${id}`))
      if (!restoring) {
        setNotice({ type: '', text: '' })
        window.scrollTo?.({ top: 0 })
      }
    } catch (error) {
      if (restoring && error?.status === 404) writeSession({ docId: null })
      else setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Document Intelligence' }) })
    } finally {
      setBusy(false)
    }
  }

  // Extraction shares the Start and the Retry buttons. The chosen file
  // stays in state on failure (setFile(null) runs on success only) so a
  // transient 504 can be retried without re-picking the document.
  const runExtraction = async () => {
    if (!file) return
    setBusy(true)
    setExtracting(true)
    setUploadError(null)
    const jobId = window.crypto?.randomUUID?.() || `boq-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const requestController = new AbortController()
    const progressController = new AbortController()
    activeExtraction.current = { jobId, requestController, progressController }
    setProgress({ status: 'reading', totalBatches: 0, completedBatches: 0, currentBatch: 0, totalSourceRows: 0, handledRows: 0, reviewCount: 0, percent: 0 })
    setNotice({ type: '', text: '' })
    writeSession({ job: { jobId, fileName: file.name, fileSize: file.size, startedAt: Date.now() } })
    onActivity?.('reading')
    let outcome = 'failed'
    let keepPolling = true
    const progressTask = (async () => {
      for (let attempt = 0; keepPolling && attempt < 420; attempt++) {
        try {
          const snapshot = await apiFetch(`/boq/progress/${jobId}`, { signal: progressController.signal, cache: 'no-store' })
          setProgress(snapshot)
          if (['completed', 'cancelled', 'failed'].includes(snapshot.status)) return snapshot
        } catch (error) {
          if (progressController.signal.aborted) return null
          if (error.status && error.status !== 404 && error.status < 500) return null
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    })()
    try {
      const formData = new FormData()
      formData.append('file', file)
      const doc = await apiFetch('/boq/process', {
        method: 'POST',
        body: formData,
        headers: { 'X-BOQ-Job-ID': jobId },
        signal: requestController.signal,
      })
      setSelected(doc)
      if (/\.pdf$/i.test(file.name)) await attachScan(file, doc.id)
      setFile(null)
      await load()
      const fix = doc.items.filter((item) => rowStatus(item) === 'fix').length
      setNotice({ type: 'success', text: `We read ${doc.items.length} items from ${doc.filename}.${fix ? ` Start with the ${fix} marked in red.` : ''}` })
      keepPolling = false
      progressController.abort()
      setProgress((current) => ({ ...current, status: 'completed', percent: 100 }))
      outcome = 'ready'
    } catch (error) {
      if (requestController.signal.aborted) {
        let cancelAccepted = true
        try {
          await apiFetch(`/boq/progress/${jobId}`, { method: 'DELETE' })
        } catch (cancelError) {
          cancelAccepted = !cancelError.status || cancelError.status >= 500
        }
        if (!cancelAccepted) {
          keepPolling = false
          progressController.abort()
        }
        const finalProgress = cancelAccepted ? await progressTask : null
        if (finalProgress?.documentId) {
          try {
            const partialDoc = await apiFetch(`/boq/${finalProgress.documentId}`)
            setSelected(partialDoc)
            if (/\.pdf$/i.test(file.name)) await attachScan(file, partialDoc.id)
            setFile(null)
            await load()
          } catch { /* progress still reports cancellation if the partial sheet cannot be loaded */ }
        }
        setProgress(finalProgress || ((current) => ({ ...current, status: 'cancelled' })))
        setNotice({ type: finalProgress?.documentId ? 'warning' : 'error', text: finalProgress?.documentId ? 'Stopped. What was already read is saved below for checking; the rest of the file was not included.' : 'Stopped before anything could be saved.' })
        return
      }
      // Backend messages for this endpoint are already user-facing — show
      // them verbatim instead of the generic friendly fallback.
      const raw = error?.message || ''
      const message = raw && !isTechnicalError(raw)
        ? raw
        : friendlyErrorMessage(error, { context: 'Document Intelligence · extraction' })
      setUploadError({ text: message, retryable: !!error?.retryable })
    } finally {
      keepPolling = false
      progressController.abort()
      await progressTask
      if (activeExtraction.current?.jobId === jobId) activeExtraction.current = null
      writeSession({ job: null })
      report(outcome)
      setExtracting(false)
      setBusy(false)
    }
  }

  // After a refresh: the page that sent the upload is gone, and the server
  // stops reading when the browser disconnects (it keeps what was already
  // read). Follow the job's progress until it ends, then open the result.
  // No second upload and no second reading are started.
  const resumeJob = async (job) => {
    setExtracting(true)
    setBusy(true)
    setResumed({ name: job.fileName || 'Your BOQ', size: job.fileSize })
    activeExtraction.current = { jobId: job.jobId, requestController: null, progressController: null, resumed: true }
    let final = null
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const snapshot = await apiFetch(`/boq/progress/${job.jobId}`, { cache: 'no-store' })
        setProgress(snapshot)
        if (['completed', 'cancelled', 'failed'].includes(snapshot.status)) { final = snapshot; break }
      } catch (error) {
        if (error?.status && error.status < 500) break // the server no longer knows this job
      }
      await sleep(1000)
    }
    writeSession({ job: null })
    activeExtraction.current = null
    setExtracting(false)
    setBusy(false)
    setResumed(null)
    if (final?.documentId) {
      await open(final.documentId, { restoring: true })
      await load()
      setNotice(final.status === 'completed'
        ? { type: 'success', text: 'Your BOQ finished reading. Here it is.' }
        : { type: 'warning', text: 'The page was reloaded while the BOQ was being read, so reading stopped. What was read before that is saved below for checking.' })
    } else if (final) {
      setNotice({ type: 'warning', text: 'The page was reloaded while the BOQ was being read, so reading stopped before anything was saved. Please upload the file again.' })
    }
  }

  const cancelExtraction = () => {
    const active = activeExtraction.current
    if (!active) return
    setProgress((current) => current ? { ...current, status: 'cancelling' } : current)
    active.requestController?.abort()
    apiFetch(`/boq/progress/${active.jobId}`, { method: 'DELETE' })
      .then(setProgress)
      .catch(() => {})
  }

  const showSaveError = (error, context) => {
    const raw = error?.message || ''
    setNotice({ type: 'error', text: [400, 409].includes(error?.status) && raw && !isTechnicalError(raw) ? raw : friendlyErrorMessage(error, { context }) })
  }

  // Save edited rows. accept: [{ lineItemId, reason }] rows the person
  // checked; unaccept: [lineItemId] (Undo). The server stamps who and when.
  const saveItems = async (items, { accept = [], unaccept = [], status, quiet = false } = {}) => {
    if (!selected) return null
    setBusy(true)
    try {
      const doc = await apiFetch(`/boq/${selected.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, status: status || selected.status, accept, unaccept }),
      })
      setSelected(doc)
      setDocuments((list) => list.map((entry) => (entry.id === doc.id ? doc : entry)))
      if (!quiet) setNotice({ type: '', text: '' })
      if (status && status !== selected.status) await load()
      return doc
    } catch (error) {
      showSaveError(error, 'Document Intelligence · save')
      return null
    } finally {
      setBusy(false)
    }
  }

  const acceptRows = async (lineItemIds, reason) => {
    if (!selected) return null
    setBusy(true)
    try {
      const doc = await apiFetch(`/boq/${selected.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: lineItemIds, reason }),
      })
      setSelected(doc)
      setDocuments((list) => list.map((entry) => (entry.id === doc.id ? doc : entry)))
      setNotice({ type: '', text: '' })
      return doc
    } catch (error) {
      showSaveError(error, 'Document Intelligence · accept')
      return null
    } finally {
      setBusy(false)
    }
  }

  const confirmDoc = async () => {
    const doc = await saveItems(selected.items, { status: 'confirmed' })
    if (doc) window.scrollTo?.({ top: 0, behavior: 'smooth' })
    return doc
  }

  const reopen = () => saveItems(selected.items, { status: 'review' })

  const remove = async (id) => {
    if (!window.confirm('Delete this BOQ and its rows? This cannot be undone.')) return
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

  // Creates (or reopens) the supply-only quotation for this confirmed BOQ.
  // The backend is idempotent per BOQ, so a second click opens the same draft.
  const createQuotation = async () => {
    setCreatingQuote(true)
    try {
      const quote = await apiFetch(`/boq/${selected.id}/quotation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      setOpenedQuote(quote)
      setNotice({ type: 'success', text: quote.created ? 'Quotation draft created below. Check which lines are pipes, then enter your rates.' : 'Opened the existing quotation for this BOQ below.' })
      window.setTimeout(() => quotationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    } catch (error) {
      showSaveError(error, 'Create quotation')
    } finally {
      setCreatingQuote(false)
    }
  }

  // Once per mount (the view stays mounted across tab changes): the list,
  // then whatever this browser tab had open before a refresh.
  const startUp = useEffectEvent(() => {
    load()
    const saved = savedSession
    if (saved.job?.jobId) resumeJob(saved.job)
    else if (saved.docId) open(saved.docId, { restoring: true })
  })
  useEffect(() => { startUp() }, [])

  const step = extracting || !selected ? 'upload' : selected.status === 'confirmed' ? 'use' : 'check'
  const selectedScan = scan && selected && scan.docId === selected.id ? scan.handle : null
  const isPdf = /\.pdf$/i.test(selected?.file_ext || selected?.filename || '')

  return (
    <div className="view-workspace boq-flow">
      <div className="boq-intro">
        <p className="eyebrow">BOQ to quotation</p>
        <h2>{selected && step !== 'upload' ? selected.filename : 'Check a BOQ'}</h2>
      </div>

      <StepHeader step={step} doc={selected} extracting={extracting} onUploadAnother={() => { if (!confirmDiscard()) return; setSelected(null); setNotice({ type: '', text: '' }) }} />

      {notice.text && <div className={`notice ${notice.type || 'info'}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      {step === 'upload' && (
        <BoqUpload
          file={extracting && resumed ? resumed : file}
          setFile={(next) => { setFile(next); setUploadError(null) }}
          extracting={extracting}
          progress={progress}
          onStart={runExtraction}
          onCancel={cancelExtraction}
          error={uploadError}
          onRetry={runExtraction}
        />
      )}

      {step === 'check' && (
        <BoqCheck
          key={selected.id}
          doc={selected}
          scan={selectedScan}
          isPdf={isPdf}
          onAttachScan={(pdfFile) => attachScan(pdfFile, selected.id)}
          saveItems={saveItems}
          acceptRows={acceptRows}
          confirmDoc={confirmDoc}
          busy={busy}
          dirtyRef={boqDirtyRef}
        />
      )}

      {step === 'use' && (
        <BoqDone
          doc={selected}
          onCreateQuotation={createQuotation}
          creatingQuote={creatingQuote}
          onExport={exportRfq}
          exporting={exporting}
          onReopen={reopen}
          busy={busy}
        />
      )}

      <div ref={quotationRef}>
        <QuotationView
          key={openedQuote ? `quote-${openedQuote.id}-${openedQuote.updated_at}` : 'quotes'}
          initialQuote={openedQuote}
          initialQuoteId={openedQuote ? null : restoredQuoteId}
          onOpenChange={rememberQuote}
          dirtyRef={quoteDirtyRef}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2>Your BOQs</h2>
          <span className="file-note">{documents.length} saved</span>
        </div>
        <div className="campaign-table-wrap">
          <table>
            <thead>
              <tr><th>Document</th><th>Items</th><th>To check</th><th>Status</th><th>Read on</th><th /></tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className={selected?.id === doc.id ? 'selected-row' : ''}>
                  <td data-label="Document"><strong>{doc.filename}</strong></td>
                  <td data-label="Items">{(doc.items || []).length}</td>
                  <td data-label="To check">{doc.review ? (doc.review.error ? `${doc.review.error} wrong · ${doc.review.glance} glance` : doc.review.glance ? `${doc.review.glance} glance` : 'Nothing') : '-'}</td>
                  <td data-label="Status"><span className={`campaign-status ${doc.status === 'confirmed' ? 'completed' : 'paused'}`}>{doc.status === 'confirmed' ? 'Confirmed' : 'Checking'}</span></td>
                  <td data-label="Read on"><small>{formatDate(doc.created_at)}</small></td>
                  <td data-label="Actions">
                    <div className="button-row">
                      <button type="button" className="secondary-btn" onClick={() => open(doc.id)}>Open</button>
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
              title="No BOQs yet"
              description="Upload a BOQ above. Its rows appear here, ready to check and turn into a quotation or an RFQ."
            />
          )}
        </div>
      </section>
    </div>
  )
}
