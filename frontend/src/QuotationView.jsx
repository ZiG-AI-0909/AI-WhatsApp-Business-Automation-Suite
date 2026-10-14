import { useEffect, useState } from 'react'
import { apiFetch, apiFetchRaw } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'

const emptyPriceItem = () => ({
  item_code: '', name: '', category: '', size: '', pressure_class: '',
  specification: '', unit: '', rate: '', hsn_code: '', gst_percent: 18,
})

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function QuotationView({ document: boqDocument }) {
  const [tab, setTab] = useState('quotations')
  const [quotes, setQuotes] = useState([])
  const [priceItems, setPriceItems] = useState([])
  const [quote, setQuote] = useState(null)
  const [matches, setMatches] = useState([])
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [priceSearch, setPriceSearch] = useState('')
  const [editingPrice, setEditingPrice] = useState(null)
  const [draftPrice, setDraftPrice] = useState(emptyPriceItem())
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const [amountWords, setAmountWords] = useState('')

  const loadPriceItems = async (term = '') => {
    const result = await apiFetch(`/boq/price-list?limit=200${term ? `&search=${encodeURIComponent(term)}` : ''}`)
    setPriceItems(result.data || [])
  }

  const loadQuotes = async () => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (statusFilter) params.set('status', statusFilter)
    const result = await apiFetch(`/quotations?${params.toString()}`)
    setQuotes(result.data || [])
  }

  useEffect(() => {
    loadPriceItems().catch((error) => setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Price list' }) }))
    loadQuotes().catch((error) => setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Quotations' }) }))
  }, [])

  useEffect(() => {
    loadQuotes().catch((error) => setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Quotations' }) }))
  }, [search, statusFilter])

  const showError = (error, context) => setNotice({ type: 'error', text: friendlyErrorMessage(error, { context }) })
  const patchQuote = (changes) => setQuote((current) => ({ ...current, ...changes }))
  const patchLine = (lineIndex, changes) => setQuote((current) => ({
    ...current,
    items: current.items.map((item, index) => index === lineIndex ? { ...item, ...changes } : item),
  }))

  const download = async (path, filename) => {
    const response = await apiFetchRaw(path)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `Download failed (${response.status})`)
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const downloadTemplate = async () => {
    try { await download('/boq/price-list/template', 'price-list-import-template.xlsx') } catch (error) { showError(error, 'Price-list template') }
  }

  const previewImport = async () => {
    if (!file) return
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      setPreview(await apiFetch('/boq/price-list/import/preview', { method: 'POST', body: form }))
    } catch (error) { showError(error, 'Price-list import preview') } finally { setBusy(false) }
  }

  const importPriceList = async () => {
    if (!file || !preview?.valid) return
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const result = await apiFetch('/boq/price-list/import', { method: 'POST', body: form })
      setNotice({ type: 'success', text: `${result.imported} catalogue item(s) imported; ${result.skipped} invalid row(s) skipped.` })
      setFile(null)
      setPreview(null)
      await loadPriceItems()
    } catch (error) { showError(error, 'Price-list import') } finally { setBusy(false) }
  }

  const savePriceItem = async (event) => {
    event.preventDefault()
    setBusy(true)
    try {
      const saved = await apiFetch(editingPrice ? `/boq/price-list/${editingPrice}` : '/boq/price-list', {
        method: editingPrice ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftPrice),
      })
      setPriceItems((current) => editingPrice
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...current])
      setEditingPrice(null)
      setDraftPrice(emptyPriceItem())
      setNotice({ type: 'success', text: 'Price-list item saved.' })
    } catch (error) { showError(error, 'Price list') } finally { setBusy(false) }
  }

  const deactivatePriceItem = async (item) => {
    try {
      const saved = await apiFetch(`/boq/price-list/${item.id}/deactivate`, { method: 'POST' })
      setPriceItems((current) => current.filter((row) => row.id !== saved.id))
    } catch (error) { showError(error, 'Price list') }
  }

  const openQuote = async (id) => {
    setBusy(true)
    try {
      const loaded = await apiFetch(`/quotations/${id}`)
      setQuote(loaded)
      setAmountWords('')
      if (loaded.boq_document_id) {
        const result = await apiFetch(`/boq/${loaded.boq_document_id}/quotation/match`, { method: 'POST' })
        setMatches(result.matches || [])
      }
      setTab('quotations')
    } catch (error) { showError(error, 'Quotation') } finally { setBusy(false) }
  }

  const createQuotation = async () => {
    if (!document || document.status !== 'confirmed') return
    setBusy(true)
    try {
      const created = await apiFetch(`/boq/${boqDocument.id}/quotation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      setQuote(created)
      const result = await apiFetch(`/boq/${boqDocument.id}/quotation/match`, { method: 'POST' })
      setMatches(result.matches || [])
      await loadQuotes()
      setNotice({ type: 'success', text: `Draft ${created.quote_number} created. Review every match before finalizing.` })
    } catch (error) { showError(error, 'Create quotation') } finally { setBusy(false) }
  }

  const chooseCatalogueItem = (index, itemId) => {
    const selectedItem = (matches[index]?.candidates || []).find((candidate) => String(candidate.item.id) === String(itemId))?.item
      || priceItems.find((item) => String(item.id) === String(itemId))
    if (!selectedItem) {
      patchLine(index, { match_status: 'unmatched', price_list_item_id: null, rate: null })
      return
    }
    patchLine(index, {
      price_list_item_id: selectedItem.id,
      description: selectedItem.name,
      size: selectedItem.size || quote.items[index].size,
      unit: selectedItem.unit,
      rate: selectedItem.rate,
      gst_percent: selectedItem.gst_percent,
      hsn_code: selectedItem.hsn_code || '',
      match_status: 'matched',
    })
  }

  const saveQuote = async () => {
    if (!quote) return
    setBusy(true)
    try {
      const saved = await apiFetch(`/quotations/${quote.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quote),
      })
      setQuote(saved)
      setNotice({ type: 'success', text: 'Quotation draft saved.' })
      await loadQuotes()
    } catch (error) { showError(error, 'Save quotation') } finally { setBusy(false) }
  }

  const finalizeQuote = async () => {
    setBusy(true)
    try {
      const saved = await apiFetch(`/quotations/${quote.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quote) })
      setQuote(saved)
      const result = await apiFetch(`/quotations/${quote.id}/finalize`, { method: 'POST' })
      setQuote(result)
      setAmountWords(result.amount_in_words || '')
      setNotice({ type: 'success', text: 'All lines are priced. The quotation is ready to export or send.' })
    } catch (error) { showError(error, 'Finalize quotation') } finally { setBusy(false) }
  }

  const duplicateQuote = async () => {
    setBusy(true)
    try {
      const copied = await apiFetch(`/quotations/${quote.id}/duplicate`, { method: 'POST' })
      setQuote(copied)
      await loadQuotes()
    } catch (error) { showError(error, 'Duplicate quotation') } finally { setBusy(false) }
  }

  const sendWhatsApp = async () => {
    if (!quote?.customer_phone) {
      setNotice({ type: 'error', text: 'Add the customer phone number before sending.' })
      return
    }
    if (!window.confirm(`Send quotation ${quote.quote_number} as a PDF to ${quote.customer_phone} via WhatsApp?`)) return
    setBusy(true)
    try {
      const result = await apiFetch(`/quotations/${quote.id}/send-whatsapp`, { method: 'POST' })
      setQuote((current) => ({ ...current, ...result }))
      setNotice({ type: 'success', text: result.message })
      await loadQuotes()
    } catch (error) { showError(error, 'Send quotation') } finally { setBusy(false) }
  }

  const renderPriceItemForm = () => <form className="settings-grid" onSubmit={savePriceItem}>
    {[
      ['item_code', 'Item code'], ['name', 'Description'], ['category', 'Category'], ['size', 'Size'],
      ['pressure_class', 'PN / pressure class'], ['specification', 'Specification / standard'],
      ['unit', 'Unit'], ['rate', 'Rate'], ['hsn_code', 'HSN'], ['gst_percent', 'GST %'],
    ].map(([field, label]) => <label className="form-label" key={field}>{label}
      <input required={['item_code', 'name', 'unit', 'rate'].includes(field)} type={['rate', 'gst_percent'].includes(field) ? 'number' : 'text'}
        step={field === 'rate' ? '0.01' : field === 'gst_percent' ? '0.01' : undefined}
        value={draftPrice[field]} onChange={(event) => setDraftPrice((current) => ({ ...current, [field]: event.target.value }))} />
    </label>)}
    <div className="button-row"><button className="primary-btn" disabled={busy}>{editingPrice ? 'Save item' : 'Add item'}</button><button type="button" className="secondary-btn" onClick={() => { setEditingPrice(null); setDraftPrice(emptyPriceItem()) }}>Clear</button></div>
  </form>

  const renderEditor = () => <section className="panel quotation-editor">
    <div className="panel-header"><div><p className="eyebrow">Quotation editor</p><h2>{quote.quote_number}</h2><span className="file-note">Status: {quote.status}</span></div><div className="button-row"><button className="secondary-btn" onClick={duplicateQuote} disabled={busy}>Duplicate</button><button className="secondary-btn" onClick={() => setQuote(null)}>Close</button></div></div>
    <div className="settings-grid">
      {[
        ['customer_name', 'Customer name'], ['customer_phone', 'Customer WhatsApp number'], ['customer_address', 'Customer address'],
        ['customer_state', 'Customer state (for GST split)'], ['customer_gstin', 'Customer GSTIN'], ['project_name', 'Project name'],
        ['validity_days', 'Validity (days)'], ['payment_terms', 'Payment terms'], ['delivery_terms', 'Delivery terms'],
        ['freight', 'Freight (₹)'], ['discount_percent', 'Overall discount (%)'], ['notes', 'Notes'],
      ].map(([field, label]) => <label className="form-label" key={field}>{label}
        {['notes', 'customer_address', 'payment_terms', 'delivery_terms'].includes(field)
          ? <textarea value={quote[field] || ''} onChange={(event) => patchQuote({ [field]: event.target.value })} />
          : <input type={['validity_days', 'freight', 'discount_percent'].includes(field) ? 'number' : 'text'}
            step={field === 'freight' || field === 'discount_percent' ? '0.01' : undefined}
            value={quote[field] ?? ''} onChange={(event) => patchQuote({ [field]: event.target.value })} />}
      </label>)}
    </div>
    <div className="campaign-table-wrap">
      <table>
        <thead><tr><th>BOQ item / source row</th><th>Matched catalogue item</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Discount %</th><th>GST %</th><th>Amount</th></tr></thead>
        <tbody>{(quote.items || []).map((item, index) => {
          const options = [
            ...(matches[index]?.candidates || []).map((candidate) => candidate.item),
            ...priceItems.filter((row) => `${row.item_code} ${row.name}`.toLowerCase().includes(priceSearch.toLowerCase())).slice(0, 20),
          ].filter((row, rowIndex, all) => all.findIndex((other) => String(other.id) === String(row.id)) === rowIndex)
          const source = item.boq_item_ref?.source || {}
          return <tr key={item.id || item.line_no} className={item.match_status === 'unmatched' ? 'row-warnings' : ''}>
            <td data-label="BOQ item">{item.boq_item_ref?.original?.product || item.description}<small>Source row {source.row || item.line_no} {source.sheet ? `· ${source.sheet}` : ''}</small></td>
            <td data-label="Matched product"><input aria-label={`Search price list for line ${index + 1}`} placeholder="Search catalogue" value={priceSearch} onChange={(event) => setPriceSearch(event.target.value)} />
              <select value={item.price_list_item_id || ''} onChange={(event) => chooseCatalogueItem(index, event.target.value)}>
                <option value="">Choose catalogue item / manual price</option>{options.map((option) => <option key={option.id} value={option.id}>{option.item_code} · {option.name} · {option.size || ''} · {option.unit} @ {money(option.rate)}</option>)}
              </select>
              {matches[index]?.reason && <small>{matches[index].reason}</small>}
              {matches[index]?.candidates?.some((candidate) => candidate.unitWarning) && <small className="campaign-error">Unit conversion needs manual review; it was not guessed.</small>}
            </td>
            <td data-label="Quantity"><input type="number" min="0.001" step="0.001" value={item.quantity ?? ''} onChange={(event) => patchLine(index, { quantity: event.target.value })} /></td>
            <td data-label="Unit"><input value={item.unit || ''} onChange={(event) => patchLine(index, { unit: event.target.value })} /></td>
            <td data-label="Rate"><input type="number" min="0" step="0.01" value={item.rate ?? ''} onChange={(event) => patchLine(index, { rate: event.target.value, match_status: item.price_list_item_id ? 'matched' : 'manual' })} /></td>
            <td data-label="Discount"><input type="number" min="0" max="100" step="0.01" value={item.discount_percent ?? 0} onChange={(event) => patchLine(index, { discount_percent: event.target.value })} /></td>
            <td data-label="GST"><input type="number" min="0" max="100" step="0.01" value={item.gst_percent ?? 0} onChange={(event) => patchLine(index, { gst_percent: event.target.value })} /></td>
            <td data-label="Amount">{money(item.amount)}<small>{item.match_status === 'unmatched' ? 'UNMATCHED' : item.match_status}</small></td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <div className="panel quotation-totals"><strong>Server-calculated totals</strong>
      <span>Subtotal: {money(quote.totals?.subtotal ?? quote.subtotal)}</span>
      <span>Discount: {money(quote.totals?.discount_amount)}</span>
      {quote.totals?.igst > 0
        ? <span>IGST: {money(quote.totals.igst)}</span>
        : <><span>CGST: {money(quote.totals?.cgst)}</span><span>SGST: {money(quote.totals?.sgst)}</span></>}
      <span>Freight: {money(quote.totals?.freight ?? quote.freight)}</span>
      <span>Grand total: {money(quote.totals?.grand_total ?? quote.grand_total)}</span>
      {(amountWords || quote.amount_in_words) && <span>Amount in words: {amountWords || quote.amount_in_words}</span>}
    </div>
    <div className="button-row">
      <button className="secondary-btn" onClick={saveQuote} disabled={busy || quote.status !== 'draft'}>Save draft</button>
      <button className="primary-btn" onClick={finalizeQuote} disabled={busy || quote.status !== 'draft'}>Finalize</button>
      <button className="secondary-btn" onClick={() => download(`/quotations/${quote.id}/export/pdf`, `${quote.quote_number.replaceAll('/', '-')}.pdf`).catch((error) => showError(error, 'Quotation PDF'))} disabled={busy}>Export PDF</button>
      <button className="secondary-btn" onClick={() => download(`/quotations/${quote.id}/export/excel`, `${quote.quote_number.replaceAll('/', '-')}.xlsx`).catch((error) => showError(error, 'Quotation Excel'))} disabled={busy}>Export Excel</button>
      <button className="primary-btn" onClick={sendWhatsApp} disabled={busy || quote.status !== 'draft'}>Send via WhatsApp</button>
    </div>
  </section>

  return <div className="quotation-workspace">
    {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    <section className="panel">
      <div className="panel-header"><div><p className="eyebrow">BOQ to Quotation</p><h2>Price list and quotations</h2></div>
        <div className="button-row"><button className={tab === 'quotations' ? 'primary-btn' : 'secondary-btn'} onClick={() => setTab('quotations')}>Quotations</button><button className={tab === 'price-list' ? 'primary-btn' : 'secondary-btn'} onClick={() => setTab('price-list')}>Price list</button></div>
      </div>
      {tab === 'price-list' ? <>
        <div className="button-row"><label className="secondary-btn upload-btn">Choose Excel/CSV<input type="file" accept=".xlsx,.csv" onChange={(event) => { setFile(event.target.files?.[0] || null); setPreview(null) }} /></label><button className="secondary-btn" onClick={downloadTemplate}>Download import template</button><button className="secondary-btn" disabled={!file || busy} onClick={previewImport}>Preview & validate</button>{preview && <button className="primary-btn" disabled={!preview.valid || busy} onClick={importPriceList}>Import {preview.valid} valid row(s)</button>}</div>
        {preview && <p className="file-note">Preview: {preview.valid} valid · {preview.invalid} invalid of {preview.total} rows.</p>}
        {preview?.rows?.some((row) => !row.valid) && <ul className="warning-list">{preview.rows.filter((row) => !row.valid).slice(0, 20).map((row) => <li key={row.rowNumber}>Row {row.rowNumber}: {row.errors.join(', ')}</li>)}</ul>}
        <h3>{editingPrice ? 'Edit price-list item' : 'Add price-list item'}</h3>{renderPriceItemForm()}
        <label className="form-label">Search price list<input value={priceSearch} onChange={(event) => { setPriceSearch(event.target.value); loadPriceItems(event.target.value).catch((error) => showError(error, 'Price list')) }} /></label>
        <div className="campaign-table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Size / PN</th><th>Unit</th><th>Rate</th><th>GST</th><th /></tr></thead><tbody>{priceItems.map((item) => <tr key={item.id}><td>{item.item_code}</td><td>{item.name}<small>{item.category || ''} {item.specification || ''}</small></td><td>{item.size || '-'} / {item.pressure_class || '-'}</td><td>{item.unit}</td><td>{money(item.rate)}</td><td>{item.gst_percent}%</td><td><div className="button-row"><button className="secondary-btn" onClick={() => { setEditingPrice(item.id); setDraftPrice(item) }}>Edit</button><button className="danger-btn" onClick={() => deactivatePriceItem(item)}>Deactivate</button></div></td></tr>)}</tbody></table></div>
      </> : <>
        {boqDocument?.status === 'confirmed' && <div className="button-row"><span className="file-note">Create a priced quotation from confirmed BOQ: {boqDocument.filename}</span><button className="primary-btn" disabled={busy} onClick={createQuotation}>Create quotation</button></div>}
        <div className="inline-fields"><label className="form-label">Search quotations<input value={search} onChange={(event) => setSearch(event.target.value)} /></label><label className="form-label">Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{['draft', 'sent', 'accepted', 'rejected', 'expired'].map((status) => <option key={status}>{status}</option>)}</select></label></div>
        <div className="campaign-table-wrap"><table><thead><tr><th>Quote</th><th>Customer</th><th>Project</th><th>Status</th><th>Total</th><th /></tr></thead><tbody>{quotes.map((item) => <tr key={item.id}><td>{item.quote_number}<small>{new Date(item.created_at).toLocaleDateString()}</small></td><td>{item.customer_name || '-'}</td><td>{item.project_name || '-'}</td><td>{item.status}</td><td>{money(item.grand_total)}</td><td><button className="secondary-btn" onClick={() => openQuote(item.id)}>Open</button></td></tr>)}</tbody></table></div>
      </>}
    </section>
    {quote && renderEditor()}
  </div>
}
