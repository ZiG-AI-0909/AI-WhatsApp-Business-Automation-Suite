import { useRef, useState } from 'react'
import { friendlyErrorMessage, isTechnicalError } from '../utils/errorMessages.js'
import { extractInvoiceFields, readInvoiceFile } from './proformaApi.js'

const ACCEPT = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf'

function message(error, context) {
  const raw = error?.message || ''
  if ([400, 413, 422, 502, 503, 504].includes(error?.status) && raw && !isTechnicalError(raw)) return raw
  return friendlyErrorMessage(error, { context })
}

// "Upload invoice to auto-fill": a photo, scan or PDF of an existing
// proforma invoice fills the form. Reading the file and extracting the
// fields are two calls, so a failed extraction is retried from the text
// already read. Nothing is saved or exported here.
export default function InvoiceUpload({ onFilled, onBeforeFill, disabled }) {
  const input = useRef(null)
  const [stage, setStage] = useState('idle') // idle | reading | extracting
  const [text, setText] = useState(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState(null)

  const extract = async (ocrText, name = fileName) => {
    setStage('extracting')
    setError(null)
    try {
      const result = await extractInvoiceFields(ocrText)
      setText(null)
      onFilled(result, name)
    } catch (failure) {
      setError({ text: message(failure, 'Reading the invoice fields'), retry: failure?.status !== 422 })
    } finally { setStage('idle') }
  }

  const choose = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!onBeforeFill()) return
    if (file.size > 15 * 1024 * 1024) {
      setError({ text: 'The file is larger than 15 MB.', retry: false })
      return
    }
    setFileName(file.name)
    setText(null)
    setError(null)
    setStage('reading')
    let read
    try {
      read = await readInvoiceFile(file)
    } catch (failure) {
      setStage('idle')
      setError({ text: message(failure, 'Reading the file'), retry: false })
      return
    }
    setText(read.text)
    await extract(read.text, file.name)
  }

  const busy = stage !== 'idle'
  return (
    <div className="pf-upload">
      <div>
        <strong>Upload invoice to auto-fill</strong>
        <p className="muted-copy">A photo, scan or PDF of an existing proforma invoice fills every section below. Check the highlighted fields, then export.</p>
      </div>
      <div className="button-row">
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={choose} />
        <button type="button" className="secondary-btn" disabled={disabled || busy} onClick={() => input.current?.click()}>
          {stage === 'reading' ? 'Reading the file…' : stage === 'extracting' ? 'Extracting fields…' : 'Upload JPG, PNG or PDF'}
        </button>
        {busy && <span className="file-note" role="status">{stage === 'reading' ? `Step 1 of 2: reading ${fileName}` : 'Step 2 of 2: finding the invoice fields'} (can take up to a minute)</span>}
      </div>
      {error && (
        <div className="notice error pf-upload-error" role="alert">
          <span>{error.text}</span>
          <div className="button-row">
            {error.retry && text && <button type="button" className="secondary-btn" onClick={() => extract(text)}>Try extraction again</button>}
            <button type="button" className="ghost-btn" onClick={() => { setError(null); setText(null) }}>Fill in by hand instead</button>
          </div>
        </div>
      )}
    </div>
  )
}
