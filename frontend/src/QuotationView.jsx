import { useEffect, useMemo, useState } from 'react'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage, isTechnicalError } from './utils/errorMessages.js'

// BOQ -> Quotation. Step 1 reviews the detector's pipe-line selection over
// every BOQ line; step 2 edits a supply-only quotation. Rates start empty and
// are typed here; every total shown comes from the server response.

const money = (value) => value === null || value === undefined || value === ''
  ? '' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const PLACEHOLDER = /\[[^\]\n]{1,160}\]/
const hasPlaceholder = (text) => PLACEHOLDER.test(String(text || ''))
const CLASS_LABELS = { pipe_plastic: 'Plastic pipe', pipe_other: 'Other pipe', not_pipe: 'Not a pipe' }
const HEADER_FIELDS = ['customer_name', 'customer_address', 'customer_gstin', 'project_name', 'reference_text', 'quote_date', 'validity_days', 'supply_type', 'gst_percent', 'discount_percent', 'freight', 'terms']
const LINE_FIELDS = ['include', 'section', 'description', 'unit', 'qty', 'rate', 'hsn', 'remarks']

const formatSource = (source = {}) => [
  source.page ? `p.${source.page}` : '',
  source.sheet ? source.sheet : '',
  source.row ? `row ${source.row}` : '',
].filter(Boolean).join(' · ')

function errorText(error, context) {
  const raw = error?.message || ''
  if ([400, 409, 422, 502].includes(error?.status) && raw && !isTechnicalError(raw)) return raw
  return friendlyErrorMessage(error, { context })
}

function specChips(spec = {}) {
  return [
    spec.material,
    spec.grade,
    spec.pressure_class,
    spec.stiffness_class,
    spec.np_class,
    spec.standard,
    spec.size_mm ? `${spec.size_mm} mm` : '',
    spec.supply_form === 'coil' ? 'coil' : '',
    spec.scope === 'installed' ? 'BOQ rate = installed' : '',
  ].filter(Boolean)
}

function headerFrom(quote) {
  return Object.fromEntries(HEADER_FIELDS.map((field) => [field, field === 'terms' ? (quote.terms || []).map((term) => ({ ...term })) : (quote[field] ?? '')]))
}

function lineFrom(item) {
  return Object.fromEntries(LINE_FIELDS.map((field) => [field, ['qty', 'rate'].includes(field) ? (item[field] ?? '') : item[field]]))
}

function sameValue(a, b) {
  if ((a === '' || a === null || a === undefined) && (b === '' || b === null || b === undefined)) return true
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return a === b
}

export default function QuotationView({ initialQuote = null }) {
  const [quotes, setQuotes] = useState([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [quote, setQuote] = useState(initialQuote)
  const [step, setStep] = useState(initialQuote?.status === 'draft' && initialQuote?.created ? 'review' : 'edit')
  const [header, setHeader] = useState(initialQuote ? headerFrom(initialQuote) : null)
  const [lines, setLines] = useState(() => initialQuote ? Object.fromEntries(initialQuote.items.map((item) => [item.id, lineFrom(item)])) : {})
  const [lineFilter, setLineFilter] = useState('pipes')
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const [sendPhone, setSendPhone] = useState('')
  const [sendOpen, setSendOpen] = useState(false)

  const readOnly = !quote || quote.status !== 'draft'

  const loadQuotes = async () => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (statusFilter) params.set('status', statusFilter)
    const result = await apiFetch(`/quotations?${params.toString()}`)
    setQuotes(result.data || [])
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      loadQuotes().catch((error) => setNotice({ type: 'error', text: errorText(error, 'Quotations') }))
    }, 250)
    return () => clearTimeout(timer)
  }, [search, statusFilter])

  const applyQuote = (next, nextStep) => {
    setQuote(next)
    setHeader(headerFrom(next))
    setLines(Object.fromEntries(next.items.map((item) => [item.id, lineFrom(item)])))
    if (nextStep) setStep(nextStep)
  }

  const itemsById = useMemo(() => Object.fromEntries((quote?.items || []).map((item) => [item.id, item])), [quote])

  const dirtyLines = useMemo(() => Object.entries(lines).flatMap(([id, line]) => {
    const item = itemsById[id]
    if (!item) return []
    const original = lineFrom(item)
    const changed = LINE_FIELDS.filter((field) => !sameValue(line[field], original[field]))
    return changed.length ? [{ id: item.id, ...Object.fromEntries(changed.map((field) => [field, line[field]])) }] : []
  }), [lines, itemsById])

  const dirtyHeader = useMemo(() => {
    if (!quote || !header) return {}
    const original = headerFrom(quote)
    return Object.fromEntries(HEADER_FIELDS.filter((field) => field === 'terms'
      ? JSON.stringify(header.terms) !== JSON.stringify(original.terms)
      : !sameValue(header[field], original[field])).map((field) => [field, header[field]]))
  }, [header, quote])

  const dirty = dirtyLines.length > 0 || Object.keys(dirtyHeader).length > 0

  const openQuote = async (id, nextStep = 'edit') => {
    setBusy(true)
    try {
      applyQuote(await apiFetch(`/quotations/${id}`), nextStep)
      setNotice({ type: '', text: '' })
    } catch (error) {
      setNotice({ type: 'error', text: errorText(error, 'Quotation') })
    } finally { setBusy(false) }
  }

  // Saves header then lines; returns the server view (with server totals).
  const save = async ({ quiet = false } = {}) => {
    if (!quote || readOnly) return quote
    let latest = quote
    if (Object.keys(dirtyHeader).length) {
      latest = await apiFetch(`/quotations/${quote.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dirtyHeader) })
    }
    if (dirtyLines.length) {
      latest = await apiFetch(`/quotations/${quote.id}/items`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: dirtyLines }) })
    }
    applyQuote(latest)
    if (!quiet) setNotice({ type: 'success', text: 'Saved. Totals recalculated by the server.' })
    return latest
  }

  const run = async (task, context) => {
    setBusy(true)
    try { await task() } catch (error) {
      setNotice({ type: 'error', text: errorText(error, context) })
    } finally { setBusy(false) }
  }

  const continueToEditor = () => run(async () => {
    await save({ quiet: true })
    setStep('edit')
    setNotice({ type: 'info', text: 'Enter a rate for every included line. Rates are your supply prices; the BOQ contract rate is shown only for reference.' })
  }, 'Save selection')

  const finalize = () => run(async () => {
    const saved = await save({ quiet: true })
    if (!saved.finalize?.ready) {
      setNotice({ type: 'error', text: 'Resolve the items listed under "Before finalizing" first.' })
      return
    }
    if (!window.confirm('Finalize this quotation? It gets the next quotation number and becomes read-only (you can still duplicate it).')) return
    const result = await apiFetch(`/quotations/${quote.id}/finalize`, { method: 'POST' })
    applyQuote(result)
    await loadQuotes()
    setNotice({ type: 'success', text: `Quotation ${result.quote_number} finalized.` })
  }, 'Finalize quotation')

  const duplicate = () => run(async () => {
    const copy = await apiFetch(`/quotations/${quote.id}/duplicate`, { method: 'POST' })
    applyQuote(copy, 'edit')
    await loadQuotes()
    setNotice({ type: 'success', text: 'Copied into a new editable draft.' })
  }, 'Duplicate quotation')

  const remove = () => run(async () => {
    if (!window.confirm('Delete this draft quotation?')) return
    await apiFetch(`/quotations/${quote.id}`, { method: 'DELETE' })
    setQuote(null)
    await loadQuotes()
    setNotice({ type: 'success', text: 'Draft deleted.' })
  }, 'Delete quotation')

  const download = (kind) => run(async () => {
    if (!readOnly && dirty) await save({ quiet: true })
    const path = kind === 'pdf' ? `/quotations/${quote.id}/export/pdf` : `/quotations/${quote.id}/export/excel${kind === 'internal' ? '?internal=1' : ''}`
    const response = await apiFetchRaw(path)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const error = new Error(body.error || `Download failed (${response.status})`)
      error.status = response.status
      throw error
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const base = (quote.quote_number || `draft-quotation-${quote.id}`).replace(/[^A-Za-z0-9-]+/g, '-')
    anchor.href = url
    anchor.download = `${base}${kind === 'internal' ? '-INTERNAL' : ''}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'Quotation download')

  const sendWhatsApp = () => run(async () => {
    const phone = sendPhone.trim()
    if (!phone) { setNotice({ type: 'error', text: 'Type the customer WhatsApp number.' }); return }
    if (!window.confirm(`Send quotation ${quote.quote_number} as a PDF to ${phone} on WhatsApp?\n\nOne message to this number only.`)) return
    const result = await apiFetch(`/quotations/${quote.id}/send-whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
    applyQuote(result)
    setSendOpen(false)
    await loadQuotes()
    setNotice({ type: 'success', text: result.message })
  }, 'Send quotation')

  const patchLine = (id, changes) => setLines((current) => ({ ...current, [id]: { ...current[id], ...changes } }))
  const patchHeader = (changes) => setHeader((current) => ({ ...current, ...changes }))
  const patchTerm = (index, text) => setHeader((current) => ({ ...current, terms: current.terms.map((term, i) => i === index ? { ...term, text } : term) }))

  const reviewItems = (quote?.items || []).filter((item) => lineFilter === 'all'
    || lines[item.id]?.include || item.spec?.detection?.classification !== 'not_pipe')
  const editorGroups = ['A', 'B'].map((section) => ({
    section,
    title: section === 'A' ? 'A. Plastic pipes (HDPE / DWC / PVC)' : 'B. Other pipe items (review)',
    items: (quote?.items || []).filter((item) => lines[item.id]?.include && lines[item.id]?.section === section),
  })).filter((group) => group.items.length)

  const renderList = () => <section className="panel">
    <div className="panel-header">
      <div><p className="eyebrow">BOQ to Quotation</p><h2>Quotations</h2></div>
    </div>
    <div className="quote-filters">
      <label className="form-label">Search<input value={search} placeholder="Quote no., customer or project" onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="form-label">Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All</option><option value="draft">Draft</option><option value="final">Final</option><option value="sent">Sent</option></select></label>
    </div>
    <div className="quote-table-scroll">
      <table className="quote-table">
        <thead><tr><th>Quotation</th><th>Customer</th><th>Project</th><th>Status</th><th className="num">Grand total</th><th>Unpriced</th><th /></tr></thead>
        <tbody>
          {quotes.map((row) => <tr key={row.id} className={quote?.id === row.id ? 'quote-row-active' : ''}>
            <td>{row.quote_number || `Draft v${row.version}`}<small className="quote-muted">{row.quote_date}</small></td>
            <td className="quote-clip">{row.customer_name || '-'}</td>
            <td className="quote-clip" title={row.project_name}>{row.project_name || '-'}</td>
            <td><span className={`quote-status quote-status-${row.status}`}>{row.status}</span></td>
            <td className="num">{money(row.grand_total)}</td>
            <td>{row.unpriced_lines ? <span className="quote-flag-error">{row.unpriced_lines}</span> : '0'}</td>
            <td><button type="button" className="secondary-btn" onClick={() => openQuote(row.id)} disabled={busy}>Open</button></td>
          </tr>)}
        </tbody>
      </table>
      {!quotes.length && <p className="quote-muted quote-empty">No quotations yet. Confirm a BOQ above and click "Create quotation".</p>}
    </div>
  </section>

  const renderReview = () => <section className="panel">
    <div className="panel-header">
      <div><p className="eyebrow">Step 1 of 2 · Review pipe lines</p><h2>Which BOQ lines do we quote?</h2>
        <span className="file-note">Plastic pipes go to section A, other pipes to section B for review; everything else is kept but excluded.</span></div>
      <div className="button-row">
        <button type="button" className={lineFilter === 'pipes' ? 'primary-btn' : 'secondary-btn'} onClick={() => setLineFilter('pipes')}>Pipes only</button>
        <button type="button" className={lineFilter === 'all' ? 'primary-btn' : 'secondary-btn'} onClick={() => setLineFilter('all')}>All {quote.items.length} lines</button>
      </div>
    </div>
    {quote.integrity?.messages?.length > 0 && <div className="notice warning">{quote.integrity.messages.join(' ')}</div>}
    <div className="quote-table-scroll">
      <table className="quote-table quote-review-table">
        <thead><tr><th>Quote</th><th>Section</th><th>BOQ No. / Code</th><th>Line</th><th>Detected as</th><th className="num">Qty</th><th>Source</th></tr></thead>
        <tbody>
          {reviewItems.map((item) => {
            const line = lines[item.id] || {}
            const detection = item.spec?.detection || {}
            return <tr key={item.id} className={line.include ? '' : 'quote-row-excluded'}>
              <td><input type="checkbox" aria-label={`Include BOQ line ${item.boq_item_no}`} checked={!!line.include} disabled={readOnly} onChange={(event) => patchLine(item.id, { include: event.target.checked })} /></td>
              <td><select aria-label="Section" value={line.section} disabled={readOnly} onChange={(event) => patchLine(item.id, { section: event.target.value })}><option value="A">A · Plastic</option><option value="B">B · Review</option></select></td>
              <td>{item.boq_item_no || '-'}<small className="quote-muted">{item.boq_item_code}</small></td>
              <td className="quote-desc" title={item.boq_description}>
                <span>{item.description}</span>
                <span className="quote-chips">{specChips(item.spec).map((chip) => <span key={chip} className="quote-chip">{chip}</span>)}</span>
                {detection.reasons?.length > 0 && <small className="quote-muted">{detection.reasons.join(' · ')}</small>}
              </td>
              <td><span className={`quote-class quote-class-${detection.classification}`}>{CLASS_LABELS[detection.classification] || '-'}</span><small className="quote-muted">{detection.confidence ? `${Math.round(detection.confidence * 100)}% sure` : ''}</small></td>
              <td className="num">{money(item.qty)} <small className="quote-muted">{item.unit}</small></td>
              <td><small className="quote-muted">{formatSource(item.spec?.source) || '-'}</small></td>
            </tr>
          })}
        </tbody>
      </table>
    </div>
    <div className="button-row quote-actions">
      <button type="button" className="primary-btn" disabled={busy || readOnly} onClick={continueToEditor}>{busy ? 'Saving…' : 'Save selection and enter rates'}</button>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => setStep('edit')}>Skip to editor</button>
    </div>
  </section>

  const field = (name, label, { type = 'text', textarea = false, ...rest } = {}) => {
    const value = header?.[name] ?? ''
    const flagged = hasPlaceholder(value)
    return <label className={`form-label ${flagged ? 'quote-placeholder' : ''}`}>{label}
      {textarea
        ? <textarea rows={3} value={value} disabled={readOnly} onChange={(event) => patchHeader({ [name]: event.target.value })} />
        : <input type={type} value={value} disabled={readOnly} onChange={(event) => patchHeader({ [name]: event.target.value })} {...rest} />}
      {flagged && <small>Replace the [bracketed] text before finalizing.</small>}
    </label>
  }

  const renderEditor = () => {
    const totals = quote.totals || {}
    let serial = 0
    return <section className="panel quote-editor">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Step 2 of 2 · Quotation editor</p>
          <h2>{quote.quote_number || `Draft quotation v${quote.version}`}</h2>
          <span className={`quote-status quote-status-${quote.status}`}>{quote.status}</span>
          {quote.sent_at && <span className="file-note"> Sent to +{quote.sent_to} on {new Date(quote.sent_at).toLocaleString()}</span>}
        </div>
        <div className="button-row">
          {!readOnly && <button type="button" className="secondary-btn" onClick={() => setStep('review')}>Back to line selection</button>}
          <button type="button" className="secondary-btn" onClick={() => setQuote(null)}>Close</button>
        </div>
      </div>
      {readOnly && <div className="notice info">This quotation is {quote.status} and read-only. Use Duplicate to make changes.</div>}

      <div className="settings-grid quote-header-grid">
        {field('customer_name', 'Customer (To)')}
        {field('customer_gstin', 'Customer GSTIN', { maxLength: 15 })}
        {field('customer_address', 'Customer address', { textarea: true })}
        {field('project_name', 'Project', { textarea: true })}
        {field('reference_text', 'Reference', { textarea: true })}
        <div className="quote-header-numbers">
          {field('quote_date', 'Quotation date', { type: 'date' })}
          {field('validity_days', 'Valid for (days)', { type: 'number', min: 1, step: 1 })}
          <label className="form-label">Supply type<select value={header.supply_type} disabled={readOnly} onChange={(event) => patchHeader({ supply_type: event.target.value })}><option value="intra">Intra-state (CGST + SGST)</option><option value="inter">Inter-state (IGST)</option></select></label>
          {field('gst_percent', 'GST %', { type: 'number', min: 0, max: 100, step: '0.01' })}
          {field('discount_percent', 'Discount %', { type: 'number', min: 0, max: 100, step: '0.01' })}
          {field('freight', 'Freight / loading (Rs)', { type: 'number', min: 0, step: '0.01' })}
        </div>
      </div>

      <div className="quote-table-scroll">
        <table className="quote-table quote-edit-table">
          <thead><tr><th>S.No</th><th>BOQ No.</th><th>Description</th><th>Unit</th><th className="num">Qty</th><th className="num">Rate (Rs)</th><th className="num">Amount (Rs)</th><th>HSN</th><th>Remarks</th><th>Checks</th></tr></thead>
          <tbody>
            {editorGroups.map((group) => [
              <tr key={`section-${group.section}`} className="quote-section-row"><td colSpan={10}>{group.title}</td></tr>,
              ...group.items.map((item) => {
                serial++
                const line = lines[item.id]
                const unpriced = line.rate === '' || line.rate === null || Number(line.rate) <= 0
                const warnings = item.warnings || []
                return <tr key={item.id} className={unpriced ? 'quote-row-unpriced' : ''}>
                  <td>{serial}</td>
                  <td>{item.boq_item_no}<small className="quote-muted">{item.boq_item_code}</small><small className="quote-muted">{formatSource(item.spec?.source)}</small></td>
                  <td className="quote-desc"><textarea rows={2} value={line.description || ''} title={item.boq_description} disabled={readOnly} className={hasPlaceholder(line.description) ? 'quote-input-placeholder' : ''} onChange={(event) => patchLine(item.id, { description: event.target.value })} />
                    <details><summary>Full BOQ text</summary><p className="quote-muted">{item.boq_description}</p></details></td>
                  <td><input className="quote-input-short" value={line.unit || ''} disabled={readOnly} onChange={(event) => patchLine(item.id, { unit: event.target.value })} /></td>
                  <td className="num"><input type="number" min="0.01" step="0.01" className="quote-input-num" value={line.qty} disabled={readOnly} onChange={(event) => patchLine(item.id, { qty: event.target.value })} /></td>
                  <td className="num">
                    <input type="number" min="0" step="0.01" placeholder="enter rate" aria-label={`Rate for BOQ line ${item.boq_item_no}`} className={`quote-input-num quote-rate-input ${unpriced ? 'quote-rate-empty' : ''}`} value={line.rate} disabled={readOnly} onChange={(event) => patchLine(item.id, { rate: event.target.value })} />
                    {item.ref_rate !== null && item.ref_rate !== undefined && <small className="quote-muted" title="Customer's BOQ contract rate (installed: supply + laying + jointing + testing). Reference only, never our rate.">BOQ contract: {money(item.ref_rate)}</small>}
                  </td>
                  <td className="num">{money(item.amount)}</td>
                  <td><input className="quote-input-short" value={line.hsn || ''} disabled={readOnly} onChange={(event) => patchLine(item.id, { hsn: event.target.value })} /></td>
                  <td><input value={line.remarks || ''} disabled={readOnly} onChange={(event) => patchLine(item.id, { remarks: event.target.value })} /></td>
                  <td className="quote-checks">
                    {unpriced && <span className="quote-flag-error">Rate missing</span>}
                    {warnings.filter((warning) => warning.code !== 'unpriced').map((warning, index) => <span key={index} className={warning.level === 'error' ? 'quote-flag-error' : 'quote-flag-warning'}>{warning.message}</span>)}
                  </td>
                </tr>
              }),
            ])}
          </tbody>
        </table>
        {!editorGroups.length && <p className="quote-muted quote-empty">No lines are included. Go back to line selection.</p>}
      </div>

      <div className="quote-bottom">
        <div className="quote-terms">
          <h3>Terms & conditions</h3>
          {(header.terms || []).map((term, index) => <div key={`${term.key}-${index}`} className={`quote-term ${hasPlaceholder(term.text) ? 'quote-placeholder' : ''}`}>
            <textarea rows={2} value={term.text} disabled={readOnly} onChange={(event) => patchTerm(index, event.target.value)} />
            {!readOnly && <button type="button" className="secondary-btn" aria-label={`Remove term ${index + 1}`} onClick={() => patchHeader({ terms: header.terms.filter((_, i) => i !== index) })}>Remove</button>}
          </div>)}
          {!readOnly && <button type="button" className="secondary-btn" onClick={() => patchHeader({ terms: [...(header.terms || []), { key: `custom_${Date.now()}`, text: '' }] })}>Add term</button>}
        </div>
        <aside className="quote-totals" aria-live="polite">
          <h3>Totals (server)</h3>
          {dirty && <p className="quote-flag-warning">Unsaved changes: save to recalculate.</p>}
          <dl>
            <dt>Sub-total</dt><dd>{money(totals.subtotal)}</dd>
            <dt>Discount ({totals.discount_percent || 0}%)</dt><dd>{money(totals.discount_amount)}</dd>
            <dt>Freight / loading</dt><dd>{money(totals.freight)}</dd>
            <dt>Taxable value</dt><dd><strong>{money(totals.taxable_value)}</strong></dd>
            {totals.supply_type === 'inter'
              ? <><dt>IGST ({totals.gst_percent}%)</dt><dd>{money(totals.igst)}</dd></>
              : <><dt>CGST ({totals.gst_percent / 2}%)</dt><dd>{money(totals.cgst)}</dd><dt>SGST ({totals.gst_percent / 2}%)</dt><dd>{money(totals.sgst)}</dd></>}
            <dt className="quote-grand">Grand total (Rs)</dt><dd className="quote-grand">{money(totals.grand_total)}</dd>
          </dl>
          <p className="quote-muted">{totals.unpriced_lines ? `${totals.unpriced_lines} included line(s) without a rate count as 0.` : totals.amount_in_words}</p>
          {!readOnly && quote.finalize?.blockers?.length > 0 && <div className="quote-blockers"><strong>Before finalizing</strong><ul>{quote.finalize.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
        </aside>
      </div>

      <div className="button-row quote-actions">
        {!readOnly && <button type="button" className="secondary-btn" disabled={busy || !dirty} onClick={() => run(() => save(), 'Save quotation')}>{busy ? 'Working…' : 'Save'}</button>}
        {!readOnly && <button type="button" className="primary-btn" disabled={busy || dirty || !quote.finalize?.ready} title={dirty ? 'Save first' : quote.finalize?.ready ? '' : 'Price every included line and replace placeholders first'} onClick={finalize}>Finalize</button>}
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => download('excel')}>Download Excel</button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => download('pdf')}>Download PDF</button>
        <button type="button" className="secondary-btn" disabled={busy} title="Adds the 'Internal - do not send' sheet with BOQ contract rates" onClick={() => download('internal')}>Excel + internal sheet</button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={duplicate}>Duplicate</button>
        {readOnly && <button type="button" className="primary-btn" disabled={busy} onClick={() => setSendOpen((open) => !open)}>Send via WhatsApp</button>}
        {!readOnly && <button type="button" className="danger-btn" disabled={busy} onClick={remove}>Delete draft</button>}
      </div>
      {sendOpen && readOnly && <div className="quote-send">
        <label className="form-label">Customer WhatsApp number<input value={sendPhone} inputMode="tel" placeholder="e.g. 98765 43210 or +91 98765 43210" onChange={(event) => setSendPhone(event.target.value)} /></label>
        <small className="quote-muted">Sends one PDF to this number from your connected WhatsApp. Nothing is sent to anyone else.</small>
        <div className="button-row"><button type="button" className="primary-btn" disabled={busy || !sendPhone.trim()} onClick={sendWhatsApp}>Send PDF</button><button type="button" className="secondary-btn" onClick={() => setSendOpen(false)}>Cancel</button></div>
      </div>}
    </section>
  }

  return <div className="quotation-workspace">
    {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    {quote && header && (step === 'review' ? renderReview() : renderEditor())}
    {renderList()}
  </div>
}
