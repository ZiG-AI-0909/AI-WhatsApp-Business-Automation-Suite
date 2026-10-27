import { useEffect, useMemo, useRef, useState } from 'react'
import { getStoredDataOwner } from '../api.js'
import { supabase } from '../supabaseClient.js'
import { friendlyErrorMessage, isTechnicalError } from '../utils/errorMessages.js'
import * as proformaApi from './proformaApi.js'
import { money } from './fields.jsx'
import InvoiceDetailsForm from './InvoiceDetailsForm.jsx'
import CompanyDetailsForm from './CompanyDetailsForm.jsx'
import PartiesForm from './PartiesForm.jsx'
import ShippingDetailsForm from './ShippingDetailsForm.jsx'
import ProductTableEditor from './ProductTableEditor.jsx'
import ChargesEditor from './ChargesEditor.jsx'
import TermsConditionsEditor from './TermsConditionsEditor.jsx'
import InvoicePreview from './InvoicePreview.jsx'
import InvoiceUpload from './InvoiceUpload.jsx'
import './proforma.css'

// Proforma Invoice Maker: one form in tabs, a live preview that matches the
// Excel export, and the .xlsx download. Totals, words and validation come
// from POST /api/proforma/preview (the same code that writes the Excel
// formulas' cached results). The open form is also kept in localStorage, so
// a refresh or a sidebar change never loses typing.

const TABS = [
  ['invoice', 'Invoice details'],
  ['company', 'Exporter & bank'],
  ['parties', 'Consignee & buyer'],
  ['shipping', 'Shipping'],
  ['products', 'Products'],
  ['charges', 'Freight & charges'],
  ['terms', 'Terms'],
  ['preview', 'Preview'],
]
const BUYER_COPY = ['name', 'address', 'country', 'tax_id', 'email', 'phone']
const DISCARD = 'This invoice has changes that are not saved. Continue without saving them?'
const DRAFT_KEY = 'sp-proforma-draft:'

function tabOf(path) {
  if (/^(invoice\.|payment\.|shipping\.incoterm)/.test(path)) return 'invoice'
  if (/^(exporter|bank)\./.test(path)) return 'company'
  if (/^(consignee|buyer)\./.test(path)) return 'parties'
  if (path.startsWith('shipping.')) return 'shipping'
  if (path.startsWith('items')) return 'products'
  if (path.startsWith('terms.')) return 'terms'
  return 'charges'
}

function newId(prefix) {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14)
  return `${prefix}${random}`
}

function errorText(error, context) {
  const raw = error?.message || ''
  if ([400, 409, 422, 503].includes(error?.status) && raw && !isTechnicalError(raw)) return raw
  return friendlyErrorMessage(error, { context })
}

const readDraft = (key) => {
  try { return JSON.parse(window.localStorage.getItem(key) || 'null') } catch { return null }
}
const writeDraft = (key, value) => {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value))
    else window.localStorage.removeItem(key)
  } catch { /* storage unavailable: the form still works, only refresh-restore is lost */ }
}

export default function ProformaView() {
  const [config, setConfig] = useState(null)
  const [invoice, setInvoice] = useState(null)
  const [savedId, setSavedId] = useState(null)
  const [snapshot, setSnapshot] = useState('')
  const [preview, setPreview] = useState(null)
  const [touched, setTouched] = useState(() => new Set())
  // Fields an uploaded invoice did not fill reliably: { path: message }.
  const [flags, setFlags] = useState({})
  // The uploaded document's printed totals, re-checked live against the form.
  const [documentTotals, setDocumentTotals] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [tab, setTab] = useState('invoice')
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState({ data: [], total: 0 })
  const [search, setSearch] = useState('')
  const draftKey = useRef(null)

  const dirty = Boolean(invoice) && JSON.stringify(invoice) !== snapshot

  // ── Load the profile defaults, then restore the draft left in this browser.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [defaults, session] = await Promise.all([
          proformaApi.loadDefaults(),
          supabase ? supabase.auth.getSession().then(({ data }) => data?.session).catch(() => null) : null,
        ])
        if (cancelled) return
        const userId = session?.user?.id || 'local'
        draftKey.current = `${DRAFT_KEY}${getStoredDataOwner(userId) || userId}`
        setConfig(defaults)
        const draft = readDraft(draftKey.current)
        if (draft?.invoice) {
          setInvoice(draft.invoice)
          setSavedId(draft.id ?? null)
          setSnapshot(draft.snapshot ?? '')
          setFlags(draft.flags || {})
          setDocumentTotals(draft.documentTotals || null)
        } else {
          setInvoice(defaults.blank)
          setSnapshot(JSON.stringify(defaults.blank))
        }
      } catch (error) {
        if (!cancelled) setNotice({ type: 'error', text: errorText(error, 'Proforma invoices') })
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Server preview (totals, words, validation), debounced while typing.
  useEffect(() => {
    if (!invoice) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      proformaApi.previewInvoice(invoice, controller.signal)
        .then(setPreview)
        .catch((error) => { if (error?.name !== 'AbortError' && !controller.signal.aborted) setNotice({ type: 'error', text: errorText(error, 'Invoice preview') }) })
    }, 350)
    return () => { clearTimeout(timer); controller.abort() }
  }, [invoice])

  // ── Keep the open form in this browser until it is saved or reset.
  useEffect(() => {
    if (!invoice || !draftKey.current) return undefined
    const timer = setTimeout(() => writeDraft(draftKey.current, { invoice, id: savedId, snapshot, flags, documentTotals }), 400)
    return () => clearTimeout(timer)
  }, [invoice, savedId, snapshot, flags, documentTotals])

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // ── Saved invoices list.
  const persistence = config?.persistence !== false
  const refreshList = async (term = search) => {
    if (!persistence) return
    try { setSaved(await proformaApi.listInvoices(term.trim())) } catch (error) {
      if (error?.status === 503) setConfig((current) => ({ ...current, persistence: false }))
    }
  }
  useEffect(() => {
    if (!config || !persistence) return undefined
    const timer = setTimeout(() => { refreshList(search) }, 250)
    return () => clearTimeout(timer)
  }, [config?.persistence, search])

  // ── Form binding.
  const errors = useMemo(() => preview?.errors || {}, [preview])
  const unflag = (path) => setFlags((current) => {
    if (!current[path]) return current
    const { [path]: _cleared, ...rest } = current
    return rest
  })
  // One field of one row in items / other_charges / terms.
  const editRow = (key, id, field, value) => {
    unflag(`${key}.${id}.${field}`)
    setInvoice((current) => ({ ...current, [key]: current[key].map((row) => (row.id === id ? { ...row, [field]: value } : row)) }))
  }
  const form = useMemo(() => ({
    get: (path) => { const [section, field] = path.split('.'); return invoice?.[section]?.[field] },
    set: (path, value) => { unflag(path); setInvoice((current) => {
      const [section, field] = path.split('.')
      const next = { ...current, [section]: { ...current[section], [field]: value } }
      const mirror = path === 'buyer.same_as_consignee' ? value : (section === 'consignee' && current.buyer.same_as_consignee && BUYER_COPY.includes(field))
      if (mirror) next.buyer = { ...next.buyer, ...Object.fromEntries(BUYER_COPY.map((key) => [key, next.consignee[key]])) }
      return next
    }) },
    setItem: (id, field, value) => editRow('items', id, field, value),
    setCharge: (id, field, value) => editRow('other_charges', id, field, value),
    setTerm: (id, field, value) => editRow('terms', id, field, value),
    touch: (path) => setTouched((current) => (current.has(path) ? current : new Set(current).add(path))),
    error: (path) => (submitted || touched.has(path) ? errors[path] || null : null),
    flag: (path) => flags[path] || null,
  }), [invoice, errors, submitted, touched, flags])

  const flagCount = useMemo(() => {
    const counts = {}
    for (const path of Object.keys(flags)) counts[tabOf(path)] = (counts[tabOf(path)] || 0) + 1
    return counts
  }, [flags])
  const errorCount = useMemo(() => {
    const counts = {}
    for (const path of Object.keys(errors)) counts[tabOf(path)] = (counts[tabOf(path)] || 0) + 1
    return counts
  }, [errors])

  const reorder = (list, id, step) => {
    const index = list.findIndex((entry) => entry.id === id)
    const target = index + step
    if (index < 0 || target < 0 || target >= list.length) return list
    const next = [...list]
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  }
  const editList = (key, update) => setInvoice((current) => ({ ...current, [key]: update(current[key]) }))
  const items = {
    onAdd: () => editList('items', (list) => [...list, { id: newId('i'), description: list.at(-1)?.description ?? config.profile.product_group, size: '', specification: '', pressure: '', coupler: '', length: list.at(-1)?.length ?? 3, hsn: list.at(-1)?.hsn ?? '', qty: '', rate: '' }]),
    onDuplicate: (id) => editList('items', (list) => list.flatMap((item) => (item.id === id ? [item, { ...item, id: newId('i') }] : [item]))),
    onRemove: (id) => editList('items', (list) => list.filter((item) => item.id !== id)),
    onMove: (id, step) => editList('items', (list) => reorder(list, id, step)),
  }

  // ── Whole-invoice actions.
  const replaceInvoice = (next, { id = null, savedJson = JSON.stringify(next), message = '' } = {}) => {
    setInvoice(next)
    setSavedId(id)
    setSnapshot(savedJson)
    setTouched(new Set())
    setSubmitted(false)
    setPreview(null)
    setFlags({})
    setDocumentTotals(null)
    setNotice(message ? { type: 'success', text: message } : { type: '', text: '' })
  }
  const confirmDiscard = () => !dirty || window.confirm(DISCARD)

  // New invoice: keep the current exporter, bank, terms and shipping
  // defaults ("previous company details"); clear parties, products, numbers.
  const newInvoice = () => {
    if (!confirmDiscard()) return
    const blank = config.blank
    const next = {
      ...blank,
      exporter: { ...invoice.exporter },
      bank: { ...invoice.bank },
      terms: invoice.terms.map((term) => ({ ...term, id: newId('t') })),
      payment: { ...blank.payment, summary: invoice.payment.summary },
      invoice: { ...blank.invoice, currency: invoice.invoice.currency, enquiry_ref: invoice.invoice.enquiry_ref },
      shipping: { ...blank.shipping, pre_carriage: invoice.shipping.pre_carriage, place_of_receipt: invoice.shipping.place_of_receipt, port_of_loading: invoice.shipping.port_of_loading, origin_country: invoice.shipping.origin_country, incoterm: invoice.shipping.incoterm },
      inland_freight: { ...blank.inland_freight, description: invoice.inland_freight.description, unit: invoice.inland_freight.unit },
    }
    replaceInvoice(next, { message: 'New invoice started with the same company, bank and terms.' })
    setTab('invoice')
  }
  const duplicateInvoice = () => {
    if (!confirmDiscard()) return
    const copy = { ...invoice, invoice: { ...invoice.invoice, number: '', date: config.blank.invoice.date } }
    replaceInvoice(copy, { savedJson: '', message: 'Copy created. Give it a new number, then save.' })
    setTab('invoice')
  }
  const loadSample = () => {
    if (!confirmDiscard()) return
    replaceInvoice(config.sample, { savedJson: '', message: 'Loaded the reference invoice (Alfatth_26-27/PI-03R5) as sample data.' })
  }
  const resetForm = () => {
    if (!window.confirm('Reset the form to a blank invoice with your saved company details? Everything typed in this invoice will be cleared.')) return
    replaceInvoice(config.blank, { message: 'Form reset.' })
    setTab('invoice')
  }

  // Upload -> auto-fill: the extracted invoice replaces the form (unsaved),
  // with its flags; nothing is saved or exported automatically.
  const fillFromUpload = (result, fileName) => {
    replaceInvoice(result.invoice, { savedJson: '', message: '' })
    setPreview({ totals: result.totals, texts: result.texts, errors: result.errors, valid: result.valid })
    setFlags(result.flags || {})
    setDocumentTotals(result.document_totals || null)
    const count = Object.keys(result.flags || {}).length
    setNotice({ type: count ? 'info' : 'success', text: `Filled the form from ${fileName}. ${count ? `${count} field(s) need checking: they are highlighted below.` : 'Check every section before exporting.'}` })
    setTab('invoice')
  }

  const openInvoice = async (id) => {
    if (id === savedId && !dirty) return
    if (!confirmDiscard()) return
    setBusy(true)
    try {
      const loaded = await proformaApi.getInvoice(id)
      replaceInvoice(loaded.invoice, { id: loaded.id })
      setPreview({ totals: loaded.totals, texts: loaded.texts, errors: loaded.errors, valid: loaded.valid })
      setTab('invoice')
    } catch (error) {
      setNotice({ type: 'error', text: errorText(error, 'Proforma invoice') })
    } finally { setBusy(false) }
  }

  const removeInvoice = async (row) => {
    if (!window.confirm(`Delete proforma invoice ${row.invoice_number || 'without a number'}? This cannot be undone.`)) return
    setBusy(true)
    try {
      await proformaApi.deleteInvoice(row.id)
      if (row.id === savedId) setSavedId(null)
      setNotice({ type: 'success', text: 'Invoice deleted.' })
      await refreshList()
    } catch (error) {
      setNotice({ type: 'error', text: errorText(error, 'Proforma invoice') })
    } finally { setBusy(false) }
  }

  const save = async () => {
    setBusy(true)
    try {
      const result = savedId ? await proformaApi.updateInvoice(savedId, invoice) : await proformaApi.createInvoice(invoice)
      setSavedId(result.id)
      setSnapshot(JSON.stringify(invoice))
      setNotice({ type: 'success', text: result.valid ? 'Invoice saved.' : 'Draft saved. Some fields still need attention before export.' })
      await refreshList()
    } catch (error) {
      if (error?.status === 503) setConfig((current) => ({ ...current, persistence: false }))
      setNotice({ type: 'error', text: errorText(error, 'Saving the invoice') })
    } finally { setBusy(false) }
  }

  const exportExcel = async () => {
    setSubmitted(true)
    if (preview && !preview.valid) {
      const first = Object.keys(preview.errors)[0]
      setTab(tabOf(first))
      setNotice({ type: 'error', text: `Fix ${Object.keys(preview.errors).length} highlighted field(s) before exporting.` })
      return
    }
    setBusy(true)
    try {
      const fileName = await proformaApi.exportInvoice(invoice)
      setNotice({ type: 'success', text: `Downloaded ${fileName}. Formulas recalculate when you edit quantities or prices in Excel.` })
    } catch (error) {
      if (error.errors) {
        setPreview((current) => ({ ...current, errors: error.errors, valid: false }))
        setTab(tabOf(Object.keys(error.errors)[0]))
      }
      setNotice({ type: 'error', text: errorText(error, 'Excel export') })
    } finally { setBusy(false) }
  }

  const saveDefaults = async () => {
    setBusy(true)
    try {
      const profile = {
        ...config.profile,
        exporter: invoice.exporter,
        bank: invoice.bank,
        terms: invoice.terms.map(({ title, text }) => ({ title, text })),
        payment_summary: invoice.payment.summary,
        enquiry_ref: invoice.invoice.enquiry_ref,
        shipping: { pre_carriage: invoice.shipping.pre_carriage, place_of_receipt: invoice.shipping.place_of_receipt, port_of_loading: invoice.shipping.port_of_loading, origin_country: invoice.shipping.origin_country, incoterm: invoice.shipping.incoterm },
        inland_freight: { description: invoice.inland_freight.description, unit: invoice.inland_freight.unit },
        ocean_freight_unit: invoice.ocean_freight.unit,
        product_group: invoice.items[0]?.description ?? config.profile.product_group,
      }
      const result = await proformaApi.saveProfile(profile)
      const defaults = await proformaApi.loadDefaults()
      setConfig({ ...defaults, profile: result.profile })
      setNotice({ type: 'success', text: 'Saved. New invoices will start with these company, bank, shipping and terms details.' })
    } catch (error) {
      setNotice({ type: 'error', text: errorText(error, 'Company defaults') })
    } finally { setBusy(false) }
  }

  const suggest = async (prefix) => {
    setBusy(true)
    try {
      const result = await proformaApi.suggestNumber(prefix, invoice.invoice.date)
      form.set('invoice.number', result.number)
      form.touch('invoice.number')
    } catch (error) {
      setNotice({ type: 'error', text: errorText(error, 'Invoice number') })
    } finally { setBusy(false) }
  }

  if (!invoice || !config) {
    return (
      <div className="view-workspace">
        <div><p className="eyebrow">Export documents</p><h2>Proforma Invoice Maker</h2></div>
        {notice.text ? <div className={`notice ${notice.type}`}>{notice.text}</div> : <p className="muted-copy">Loading…</p>}
      </div>
    )
  }

  const totals = preview?.totals
  const differs = (printed, current) => printed != null && current != null && Math.abs(printed - current) > 0.01
  const warnings = !documentTotals || !totals ? [] : [
    ['Total Ex-Works', documentTotals.ex_works, totals.ex_works],
    ['Total FOB', documentTotals.fob, totals.fob],
    ['Grand Total', documentTotals.grand_total, totals.grand_total],
    ['value in figures', documentTotals.value_in_figures, totals.grand_total],
  ].filter(([, printed, current]) => differs(printed, current))
    .map(([label, printed, current]) => `The uploaded document's ${label} is ${money(printed)}; this invoice now totals ${money(current)}.`)
    .concat(differs(documentTotals.balance, totals.balance) ? [`The uploaded document's payment balance is ${money(documentTotals.balance)}; this invoice prints the calculated balance ${money(totals.balance)}.`] : [])
  const currency = invoice.invoice.currency
  const amounts = new Map((totals?.items || []).map((item) => [item.id, item.amount]))
  const errorTotal = Object.keys(errors).length

  return (
    <div className="view-workspace proforma-view">
      <div>
        <p className="eyebrow">Export documents</p>
        <h2>Proforma Invoice Maker</h2>
        <p className="muted-copy">Fill in the invoice section by section, check the preview, then download an Excel file laid out like the Sudarshan proforma invoice, with live formulas.</p>
      </div>
      {notice.text && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
      {!persistence && <div className="notice info">Saving invoices and company defaults needs a database update (run <code>supabase-proforma-migration.sql</code> in the Supabase SQL Editor). You can still fill in, preview and export invoices; this form is kept in this browser.</div>}

      {persistence && (
        <details className="panel pf-saved" open={saved.total > 0 && !savedId}>
          <summary><strong>Saved invoices</strong> <span className="file-note">{saved.total}</span></summary>
          <label className="form-label pf-search">Search
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Number, consignee or buyer" />
          </label>
          {saved.data.length ? (
            <div className="campaign-table-wrap">
              <table className="quote-table">
                <thead><tr><th>Number</th><th>Date</th><th>Consignee</th><th className="num">Grand total</th><th>Updated</th><th /></tr></thead>
                <tbody>
                  {saved.data.map((row) => (
                    <tr key={row.id} className={row.id === savedId ? 'pf-current' : undefined}>
                      <td data-label="Number"><strong>{row.invoice_number || '(no number)'}</strong></td>
                      <td data-label="Date">{row.invoice_date || '—'}</td>
                      <td data-label="Consignee">{row.consignee_name || '—'}</td>
                      <td data-label="Grand total" className="num">{row.currency} {money(row.grand_total)}</td>
                      <td data-label="Updated">{new Date(row.updated_at).toLocaleString()}</td>
                      <td data-label="Actions"><div className="button-row">
                        <button type="button" className="secondary-btn" disabled={busy} onClick={() => openInvoice(row.id)}>{row.id === savedId ? 'Open (current)' : 'Open'}</button>
                        <button type="button" className="danger-btn" disabled={busy} onClick={() => removeInvoice(row)}>Delete</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted-copy">{search ? 'No saved invoice matches.' : 'No saved invoices yet. Save one to find it here.'}</p>}
        </details>
      )}

      <section className="panel pf-editor">
        <div className="panel-header pf-editor-head">
          <div>
            <p className="eyebrow">{savedId ? 'Saved invoice' : 'Create new proforma invoice'}</p>
            <h2>{invoice.invoice.number || 'New proforma invoice'}</h2>
            <span className={`pf-state ${dirty ? 'is-dirty' : 'is-clean'}`}>{dirty ? 'Unsaved changes' : savedId ? 'All changes saved' : 'Not saved yet'}</span>
          </div>
          <div className="button-row">
            <button type="button" className="secondary-btn" disabled={busy} onClick={newInvoice}>New invoice</button>
            <button type="button" className="secondary-btn" disabled={busy} onClick={duplicateInvoice}>Duplicate</button>
            <button type="button" className="secondary-btn" disabled={busy} onClick={loadSample}>Load sample</button>
            <button type="button" className="ghost-btn" disabled={busy} onClick={resetForm}>Reset form</button>
            {persistence && <button type="button" className="secondary-btn" disabled={busy} onClick={save}>{savedId ? 'Save' : 'Save invoice'}</button>}
            <button type="button" className="primary-btn" disabled={busy} onClick={exportExcel}>Export to Excel (.xlsx)</button>
          </div>
        </div>

        {!savedId && <InvoiceUpload onFilled={fillFromUpload} onBeforeFill={confirmDiscard} disabled={busy} />}

        {(Object.keys(flags).length > 0 || warnings.length > 0) && (
          <div className="pf-review" role="region" aria-label="Fields to check from the uploaded invoice">
            <strong>Check before exporting</strong>
            {warnings.map((warning) => <p key={warning}>{warning}</p>)}
            {Object.keys(flags).length > 0 && <p>
              {Object.keys(flags).length} field(s) were not read reliably from the upload:{' '}
              {TABS.filter(([key]) => flagCount[key]).map(([key, label], index) => (
                <span key={key}>{index ? ', ' : ''}<button type="button" className="pf-link" onClick={() => setTab(key)}>{label} ({flagCount[key]})</button></span>
              ))}
            </p>}
            <button type="button" className="ghost-btn" onClick={() => { setFlags({}); setDocumentTotals(null) }}>Dismiss all</button>
          </div>
        )}

        <div className="pf-tabs" role="tablist" aria-label="Invoice sections">
          {TABS.map(([key, label]) => (
            <button key={key} type="button" role="tab" id={`pf-tab-${key}`} aria-selected={tab === key} aria-controls="pf-tabpanel" className={tab === key ? 'active' : undefined} onClick={() => setTab(key)}>
              {label}{submitted && errorCount[key] ? <span className="pf-badge" aria-label={`${errorCount[key]} to fix`}>{errorCount[key]}</span>
                : flagCount[key] ? <span className="pf-badge pf-badge-flag" aria-label={`${flagCount[key]} to check`}>{flagCount[key]}</span> : null}
            </button>
          ))}
        </div>

        <div className="pf-tabpanel" id="pf-tabpanel" role="tabpanel" aria-labelledby={`pf-tab-${tab}`}>
          {tab === 'invoice' && <InvoiceDetailsForm form={form} invoice={invoice} currencies={config.currencies} incoterms={config.incoterms} totals={totals} numbering={config.profile.numbering} onSuggestNumber={suggest} busy={busy} />}
          {tab === 'company' && <CompanyDetailsForm form={form} onSaveDefaults={saveDefaults} profileSaved={config.profile_saved} persistence={persistence} busy={busy} />}
          {tab === 'parties' && <PartiesForm form={form} invoice={invoice} />}
          {tab === 'shipping' && <ShippingDetailsForm form={form} deliveryTerms={[invoice.shipping.incoterm, invoice.shipping.incoterm_place].filter(Boolean).join(' ')} />}
          {tab === 'products' && <ProductTableEditor items={invoice.items} form={form} amounts={amounts} currency={currency} totals={totals} {...items} />}
          {tab === 'charges' && <ChargesEditor form={form} invoice={invoice} totals={totals} currency={currency}
            onAddCharge={() => editList('other_charges', (list) => [...list, { id: newId('c'), description: '', unit: 'Lot', qty: 1, rate: '', include_in_total: true }])}
            onRemoveCharge={(id) => editList('other_charges', (list) => list.filter((charge) => charge.id !== id))} />}
          {tab === 'terms' && <TermsConditionsEditor terms={invoice.terms} texts={preview?.texts?.terms} form={form}
            onAdd={() => editList('terms', (list) => [...list, { id: newId('t'), title: '', text: '' }])}
            onRemove={(id) => editList('terms', (list) => list.filter((term) => term.id !== id))}
            onMove={(id, step) => editList('terms', (list) => reorder(list, id, step))}
            onRestore={() => window.confirm('Replace these terms with your standard terms?') && editList('terms', () => config.blank.terms.map((term) => ({ ...term, id: newId('t') })))} />}
          {tab === 'preview' && <InvoicePreview invoice={invoice} preview={preview} />}
        </div>

        <div className="pf-footer" aria-live="polite">
          <div>
            <span className="file-note">Grand Total</span>
            <strong>{currency} {money(totals?.grand_total)}</strong>
            <small className="muted-copy">{totals?.amount_in_words}</small>
          </div>
          <div className="button-row">
            {submitted && errorTotal > 0 && <span className="pf-error">{errorTotal} field(s) to fix</span>}
            {preview?.valid && <span className="pf-ok">Ready to export</span>}
            <button type="button" className="primary-btn" disabled={busy} onClick={exportExcel}>Export to Excel (.xlsx)</button>
          </div>
        </div>
      </section>
    </div>
  )
}
