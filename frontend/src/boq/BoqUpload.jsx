import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { fileSize, formatIN } from './boqReview.js'

const ACCEPT = '.xlsx,.docx,.pdf,.txt,.csv,.md'
const ACCEPT_PATTERN = /\.(xlsx|docx|pdf|txt|csv|md)$/i

// Plain-language stages. The server reports "reading" (text + OCR of the
// pages) and then "extracting" (one part of the table at a time); the
// numbers are checked when the result comes back.
const STAGES = [
  { id: 'reading', label: 'Reading pages' },
  { id: 'extracting', label: 'Finding the table' },
  { id: 'checking', label: 'Checking numbers' },
]

function stageIndex(progress, finishing) {
  if (finishing) return 2
  if (!progress) return 0
  if (progress.status === 'extracting') return progress.totalBatches && progress.completedBatches >= progress.totalBatches ? 2 : 1
  return 0
}

function elapsedText(seconds) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Step 1: choose a file and watch it being read.
 * file / setFile come from the parent so a failed run can be retried.
 */
export default function BoqUpload({ file, setFile, extracting, progress, onStart, onCancel, error, onRetry }) {
  const [dragging, setDragging] = useState(false)
  const [rejected, setRejected] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!extracting) return undefined
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => { window.clearInterval(timer); setElapsed(0) }
  }, [extracting])

  const choose = (candidate) => {
    if (!candidate) return
    if (!ACCEPT_PATTERN.test(candidate.name)) {
      setRejected(`"${candidate.name}" is not a BOQ file we can read. Choose a PDF, Excel (.xlsx), Word (.docx), CSV or text file.`)
      return
    }
    setRejected('')
    setFile(candidate)
  }

  const onDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    if (extracting) return
    choose(event.dataTransfer?.files?.[0])
  }

  const current = stageIndex(progress, extracting && progress?.status === 'completed')
  const cancelling = progress?.status === 'cancelling'
  const percent = Math.max(extracting ? 4 : 0, Math.min(100, progress?.percent || 0))
  const part = progress?.totalBatches ? `part ${Math.min(progress.totalBatches, Math.max(1, progress.currentBatch || progress.completedBatches || 1))} of ${progress.totalBatches}` : ''

  return (
    <section className="panel boq-upload" aria-labelledby="boq-upload-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Step 1</p>
          <h2 id="boq-upload-title">Upload the BOQ</h2>
        </div>
      </div>

      {!extracting && (
        <>
          <label
            className={`boq-dropzone${dragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <span className="boq-dropzone-icon" aria-hidden="true"><Icon name={file ? 'file' : 'upload'} size={28} /></span>
            {file ? (
              <span className="boq-file">
                <strong>{file.name}</strong>
                <small>{fileSize(file.size)} · ready to read</small>
              </span>
            ) : (
              <span className="boq-dropzone-text">
                <strong>Drop the BOQ here, or click to choose it</strong>
                <small>PDF (also scanned, up to 20 pages), Excel, Word or CSV</small>
              </span>
            )}
            <input ref={inputRef} type="file" accept={ACCEPT} onChange={(event) => { choose(event.target.files?.[0]); event.target.value = '' }} />
          </label>
          {rejected && <div className="notice error" role="alert">{rejected}</div>}
          {error && (
            <div className="notice error" role="alert">
              <span>{error.text}</span>
              {error.retryable && file && <button type="button" className="secondary-btn" onClick={onRetry}>Try again</button>}
            </div>
          )}
          <div className="button-row boq-upload-actions">
            <button type="button" className="primary-btn boq-big-btn" onClick={onStart} disabled={!file}>
              <Icon name="sparkles" size={18} /> Read this BOQ
            </button>
            {file && <button type="button" className="ghost-btn" onClick={() => setFile(null)}>Choose a different file</button>}
          </div>
          <p className="file-note">A scanned PDF takes up to about 2 minutes. You can keep this page open and wait.</p>
        </>
      )}

      {extracting && (
        <div className="boq-progress" role="status" aria-live="polite">
          <div className="boq-progress-file">
            <Icon name="file" size={20} />
            <span><strong>{file?.name || 'Your BOQ'}</strong>{file ? <small>{fileSize(file.size)}</small> : null}</span>
            <span className="boq-elapsed mono" aria-label={`Time so far ${elapsedText(elapsed)}`}>{elapsedText(elapsed)}</span>
          </div>
          <progress className="is-live" value={percent} max="100" aria-label="Reading progress" />
          <ol className="boq-stages">
            {STAGES.map((stage, index) => {
              const state = index < current ? 'done' : index === current ? 'current' : 'todo'
              return (
                <li key={stage.id} className={`boq-stage ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                  <span className="boq-stage-dot" aria-hidden="true">{state === 'done' ? <Icon name="check" size={13} /> : index + 1}</span>
                  <span>
                    <strong>{stage.label}</strong>
                    {state === 'current' && index === 1 && (part || progress?.totalSourceRows) ? (
                      <small>{[part, progress?.totalSourceRows ? `${formatIN(progress.handledRows || 0)} of ${formatIN(progress.totalSourceRows)} rows` : ''].filter(Boolean).join(' · ')}</small>
                    ) : null}
                    {state === 'current' && index === 0 ? <small>Scanned pages are read one by one</small> : null}
                  </span>
                </li>
              )
            })}
          </ol>
          <div className="button-row">
            <button type="button" className="secondary-btn" onClick={onCancel} disabled={cancelling}>
              <Icon name="close" size={16} /> {cancelling ? 'Stopping…' : 'Cancel'}
            </button>
            <span className="file-note">Cancel keeps what was already read, so you can still check it.</span>
          </div>
        </div>
      )}
    </section>
  )
}
