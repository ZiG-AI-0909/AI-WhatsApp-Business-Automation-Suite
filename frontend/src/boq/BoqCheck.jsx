import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import Modal from '../components/Modal.jsx'
import ScanView from './ScanView.jsx'
import {
  FILTERS, STATUS_ICON, STATUS_LABEL, checkNumbers, formatIN, formatMoney, hasPriceColumns, isUnresolved,
  liveNumberText, mainReason, matchesSearch, noteText, pageOf, parseNumber, round2, rowStatus,
} from './boqReview.js'

const EDIT_FIELDS = ['quantity', 'unit', 'rate', 'amount']
const KEEP_REASONS = ['Matches the printed BOQ', 'The printed BOQ itself has this mistake', 'I will check this with the customer']

function useIsPhone() {
  const query = '(max-width: 767px)'
  const [phone, setPhone] = useState(() => {
    try { return window.matchMedia(query).matches } catch { return false }
  })
  useEffect(() => {
    let media
    try { media = window.matchMedia(query) } catch { return undefined }
    const onChange = () => setPhone(media.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])
  return phone
}

const draftOf = (item) => Object.fromEntries(EDIT_FIELDS.map((field) => [field, item?.[field] === null || item?.[field] === undefined ? '' : String(item[field])]))
const draftDirty = (item, draft) => Boolean(item && draft) && EDIT_FIELDS.some((field) => {
  const before = item[field] === null || item[field] === undefined ? '' : String(item[field])
  if (field === 'unit') return before.trim() !== String(draft[field] ?? '').trim()
  return parseNumber(before) !== parseNumber(draft[field]) || (before.trim() === '') !== (String(draft[field] ?? '').trim() === '')
})
const applyDraft = (item, draft) => ({
  ...item,
  quantity: parseNumber(draft.quantity),
  rate: parseNumber(draft.rate),
  amount: parseNumber(draft.amount),
  unit: String(draft.unit ?? '').trim() || null,
})

// Next unresolved row after `fromId` (wrapping), wrong numbers before glances.
function nextProblemIn(list, fromId) {
  const start = Math.max(0, list.findIndex((item) => item.lineItemId === fromId))
  const rotated = [...list.slice(start + 1), ...list.slice(0, start + 1)]
  return rotated.find((item) => rowStatus(item) === 'fix') || rotated.find((item) => rowStatus(item) === 'glance') || null
}

function StatusChip({ status, compact = false }) {
  return (
    <span className={`boq-chip status-${status}`}>
      <Icon name={STATUS_ICON[status]} size={compact ? 13 : 14} />
      <span className={compact ? 'chip-label' : ''}>{STATUS_LABEL[status]}</span>
    </span>
  )
}

function SummaryCard({ items, validation, counts, onNext, nextAvailable }) {
  const sum = round2(items.reduce((total, item) => total + (parseNumber(item.amount) || 0), 0))
  const printed = validation?.printedTotal ?? null
  const difference = printed === null ? null : round2(printed - sum)
  const matches = difference !== null && Math.abs(difference) <= 1
  return (
    <section className="panel boq-summary" aria-label="Check summary">
      <dl className="boq-summary-stats">
        <div><dt>Items found</dt><dd className="mono">{formatIN(counts.total)}</dd></div>
        <div className="stat-ok"><dt><Icon name="check-circle" size={15} /> OK</dt><dd className="mono">{formatIN(counts.ok)}</dd></div>
        <div className={counts.fix ? 'stat-attention' : counts.glance ? 'stat-glance' : 'stat-ok'}>
          <dt><Icon name={counts.attention ? 'alert' : 'check-circle'} size={15} /> Need your attention</dt>
          <dd className="mono">{formatIN(counts.attention)}</dd>
          {counts.attention > 0 && <small className="boq-stat-split">{counts.fix} wrong {counts.fix === 1 ? 'number' : 'numbers'} · {counts.glance} to glance</small>}
        </div>
        <div className="stat-fixed"><dt><Icon name="check" size={15} /> Fixed or checked by you</dt><dd className="mono">{formatIN(counts.resolved)}</dd></div>
      </dl>
      <div className={`boq-total ${difference === null ? 'unknown' : matches ? 'matches' : 'differs'}`}>
        <Icon name={difference === null ? 'info' : matches ? 'check-circle' : 'alert'} size={18} />
        {difference === null ? (
          <span>Sum of amounts <strong className="mono">{formatMoney(sum)}</strong>. No printed total was found to compare with.</span>
        ) : matches ? (
          <span>Printed total <strong className="mono">{formatMoney(printed)}</strong> matches the sum of amounts.</span>
        ) : (
          <span>Printed total <strong className="mono">{formatMoney(printed)}</strong>, sum of amounts <strong className="mono">{formatMoney(sum)}</strong>: <strong>differs by <span className="mono">{formatMoney(Math.abs(difference))}</span></strong>.</span>
        )}
      </div>
      <button type="button" className="primary-btn boq-big-btn boq-next-btn" onClick={onNext} disabled={!nextAvailable}>
        {nextAvailable ? <>Next problem <Icon name="chevron-right" size={18} /></> : <><Icon name="check-circle" size={18} /> Nothing left to check</>}
      </button>
    </section>
  )
}

function QuotationLines({ items, selectedId, onOpen }) {
  const lines = items.filter((item) => item.forQuotation)
  if (!lines.length) return null
  const open = lines.filter(isUnresolved).length
  return (
    <details className="panel boq-quote-lines" open>
      <summary>
        <span><Icon name="clipboard" size={17} /> <strong>Lines for the quotation</strong> <span className="file-note">({lines.length} pipe and stoneware lines)</span></span>
        <span className={`boq-chip ${open ? 'status-glance' : 'status-ok'}`}><Icon name={open ? 'eye' : 'check-circle'} size={13} />{open ? `${open} to check` : 'All checked'}</span>
      </summary>
      <div className="boq-quote-table">
        <table>
          <thead><tr><th>BOQ S.No</th><th>Size</th><th>Specification</th><th className="num">Quantity</th><th>Status</th></tr></thead>
          <tbody>
            {lines.map((item) => {
              const status = rowStatus(item)
              return (
                <tr key={item.lineItemId} className={item.lineItemId === selectedId ? 'selected-row' : ''} onClick={() => onOpen(item)}>
                  <td><button type="button" className="link-btn" onClick={(event) => { event.stopPropagation(); onOpen(item) }} aria-label={`Open S.No ${item.serialNumber || '?'}`}>{item.serialNumber || '—'}</button></td>
                  <td>{item.size || '—'}</td>
                  <td className="boq-spec">{item.specification || '—'}</td>
                  <td className="num mono">{formatIN(item.quantity)} {item.unit || ''}</td>
                  <td><StatusChip status={status} compact /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function RowEditor({ item, priced, draft, setDraft, onSave, onLooksFine, onKeep, onCancel, onRemove, onFieldsChange, busy, scan, isPdf, onAttachScan, onClose, phone }) {
  const [details, setDetails] = useState(false)
  const [keeping, setKeeping] = useState(false)
  const [reason, setReason] = useState(KEEP_REASONS[0])
  const [otherReason, setOtherReason] = useState('')
  const firstInput = useRef(null)
  const status = rowStatus(item)
  const check = checkNumbers(draft, priced)
  const dirty = draftDirty(item, draft)
  const notes = Array.isArray(item.reviewNotes) ? item.reviewNotes : []
  const tone = status === 'fix' ? 'danger' : status === 'glance' ? 'warning' : 'success'

  const set = (field) => (event) => setDraft({ ...draft, [field]: event.target.value })
  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && event.target.tagName !== 'TEXTAREA') { event.preventDefault(); onSave() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
  }

  const helpers = []
  const { quantity: q, rate: r, amount: a, computed } = check
  if (!check.ok && q !== null && q > 0 && r !== null && r > 0) {
    helpers.push({ id: 'amount', label: 'Use quantity × rate as amount', from: a, to: computed, field: 'amount', apply: () => setDraft({ ...draft, amount: String(computed) }) })
  }
  if (!check.ok && a !== null && a > 0 && r !== null && r > 0) {
    const value = round2(a / r)
    if (value !== q) helpers.push({ id: 'quantity', label: 'Use amount ÷ rate as quantity', from: q, to: value, field: 'quantity', apply: () => setDraft({ ...draft, quantity: String(value) }) })
  }
  if (!check.ok && r === null && a !== null && a > 0 && q !== null && q > 0) {
    const value = round2(a / q)
    helpers.push({ id: 'rate', label: 'Use amount ÷ quantity as rate', from: null, to: value, field: 'rate', apply: () => setDraft({ ...draft, rate: String(value) }) })
  }

  const keepReason = reason === 'other' ? otherReason.trim() : reason
  const field = (name, label, props = {}) => {
    const flagged = !check.ok && (
      (check.code === 'amount_mismatch' && ['quantity', 'rate', 'amount'].includes(name))
      || (check.code === 'quantity_missing' && name === 'quantity')
      || (check.code === 'rate_missing' && name === 'rate')
      || (check.code === 'amount_missing' && name === 'amount')
      || (check.code === 'rate_amount_missing' && ['rate', 'amount'].includes(name))
    )
    return (
      <label className={`form-label boq-field${flagged ? ' is-flagged' : ''}`}>
        {label}
        <input
          ref={name === 'quantity' ? firstInput : undefined}
          value={draft[name]}
          onChange={set(name)}
          onKeyDown={onKeyDown}
          inputMode={name === 'unit' ? 'text' : 'decimal'}
          className={name === 'unit' ? '' : 'mono'}
          aria-invalid={flagged ? 'true' : undefined}
          {...props}
        />
      </label>
    )
  }

  return (
    <div className={`boq-editor tone-${tone}`} data-row={item.lineItemId}>
      <div className="boq-editor-head">
        <div>
          <p className="eyebrow">BOQ S.No {item.serialNumber || '—'}{item.itemCode ? ` · code ${item.itemCode}` : ''}{pageOf(item) ? ` · page ${pageOf(item)}` : ''}</p>
          <h3 id="boq-editor-title" className="boq-editor-title">{item.description || item.product || 'No description'}</h3>
        </div>
        <div className="boq-editor-head-actions">
          <StatusChip status={status} />
          {phone && <button type="button" className="icon-btn" onClick={onClose} aria-label="Close this row"><Icon name="close" /></button>}
        </div>
      </div>

      {notes.length > 0 && (
        <ul className="boq-reasons">
          {notes.map((note, index) => (
            <li key={`${note.code}-${index}`} className={note.severity === 'error' ? 'is-error' : 'is-glance'}>
              <Icon name={note.severity === 'error' ? 'x-circle' : 'eye'} size={16} />
              <span><span className="visually-hidden">{note.severity === 'error' ? 'Wrong number: ' : 'Please glance: '}</span>{noteText(note, item)}</span>
            </li>
          ))}
        </ul>
      )}
      {item.acceptance && (
        <p className="boq-accepted"><Icon name="check" size={15} /> {status === 'kept' ? 'Kept as is' : 'Marked as fine'} by {item.acceptance.by}: “{item.acceptance.reason}”</p>
      )}

      <ScanView item={item} scan={scan} isPdf={isPdf} onAttach={onAttachScan} tone={tone} />

      <div className="boq-fields" onKeyDown={onKeyDown}>
        {field('quantity', 'Quantity')}
        {field('unit', 'Unit', { autoCapitalize: 'off' })}
        {field('rate', 'Rate (Rs)')}
        {field('amount', 'Amount (Rs)')}
      </div>
      <p className={`boq-live ${check.ok ? 'is-ok' : 'is-bad'}`} role="status" aria-live="polite">
        <Icon name={check.ok ? 'check-circle' : 'x-circle'} size={16} />
        {check.ok
          ? (check.code === 'no_numbers' ? 'No numbers on this line.' : priced ? `Quantity × rate = amount (${formatMoney(check.computed)})` : 'Quantity is readable.')
          : liveNumberText(check)}
      </p>

      {helpers.length > 0 && (
        <div className="boq-helpers" role="group" aria-label="Quick fixes">
          {helpers.map((helper) => (
            <button key={helper.id} type="button" className="secondary-btn boq-helper" onClick={helper.apply}>
              <span>{helper.label}</span>
              <small className="mono">{helper.from === null || helper.from === undefined ? '' : `${formatIN(helper.from, { money: helper.field !== 'quantity' })} → `}{formatIN(helper.to, { money: helper.field !== 'quantity' })}</small>
            </button>
          ))}
        </div>
      )}

      {keeping ? (
        <fieldset className="boq-keep">
          <legend>Why keep these numbers?</legend>
          {KEEP_REASONS.map((option) => (
            <label key={option} className="check-label"><input type="radio" name="keep-reason" checked={reason === option} onChange={() => setReason(option)} /> {option}</label>
          ))}
          <label className="check-label"><input type="radio" name="keep-reason" checked={reason === 'other'} onChange={() => setReason('other')} /> Something else</label>
          {reason === 'other' && <input value={otherReason} onChange={(event) => setOtherReason(event.target.value)} placeholder="Type the reason" aria-label="Reason for keeping the numbers" autoFocus />}
          <div className="button-row">
            <button type="button" className="primary-btn" disabled={busy || !keepReason} onClick={() => onKeep(keepReason)}>Keep as is</button>
            <button type="button" className="ghost-btn" onClick={() => setKeeping(false)}>Back</button>
          </div>
        </fieldset>
      ) : (
        <div className="button-row boq-editor-actions">
          <button type="button" className="primary-btn" disabled={busy} onClick={onSave}>
            <Icon name="check" size={17} /> {dirty ? 'Save and go to next' : status === 'glance' ? 'Looks fine, next' : 'Next problem'}
          </button>
          {status === 'glance' && dirty && <button type="button" className="secondary-btn" disabled={busy} onClick={onLooksFine}>Looks fine as it was</button>}
          {['fix'].includes(status) && !check.ok && <button type="button" className="secondary-btn" disabled={busy} onClick={() => setKeeping(true)}>Use my value</button>}
          {dirty && <button type="button" className="ghost-btn" onClick={onCancel}>Cancel changes</button>}
        </div>
      )}
      {!phone && <p className="boq-shortcuts" aria-hidden="true"><kbd>Enter</kbd> save and next · <kbd>Esc</kbd> cancel changes · <kbd>J</kbd>/<kbd>K</kbd> or <kbd>↓</kbd>/<kbd>↑</kbd> move · <kbd>N</kbd> next problem</p>}

      <button type="button" className="ghost-btn boq-details-toggle" aria-expanded={details} onClick={() => setDetails((open) => !open)}>
        <Icon name={details ? 'chevron-left' : 'chevron-right'} size={16} /> {details ? 'Hide details' : 'Show details'}
      </button>
      {details && (
        <div className="boq-details">
          <div className="form-grid">
            <label className="form-label">Item code<input defaultValue={item.itemCode || ''} onBlur={(event) => event.target.value !== (item.itemCode || '') && onFieldsChange({ itemCode: event.target.value })} /></label>
            <label className="form-label">Size<input defaultValue={item.size || ''} onBlur={(event) => event.target.value !== (item.size || '') && onFieldsChange({ size: event.target.value })} /></label>
            <label className="form-label full-field">Specification<input defaultValue={item.specification || ''} onBlur={(event) => event.target.value !== (item.specification || '') && onFieldsChange({ specification: event.target.value })} /></label>
            <label className="form-label full-field">Description<textarea rows={3} defaultValue={item.description || ''} onBlur={(event) => event.target.value !== (item.description || '') && onFieldsChange({ description: event.target.value })} /></label>
          </div>
          {item.rawDescription && item.rawDescription !== item.description && (
            <div className="boq-detail-block"><h4>Text as read from the scan</h4><p className="quote-muted">{item.rawDescription}</p></div>
          )}
          {item.ocr && (
            <div className="boq-detail-block">
              <h4>Numbers as read from the scan</h4>
              <dl className="boq-ocr">
                {['quantity', 'unit', 'rate', 'words', 'amount'].map((key) => (
                  <div key={key}><dt>{{ quantity: 'Quantity', unit: 'Unit', rate: 'Rate', words: 'Rate in words', amount: 'Amount' }[key]}</dt><dd className="mono">{item.ocr[key] || '(blank)'}</dd></div>
                ))}
              </dl>
            </div>
          )}
          {(item.corrections || []).length > 0 && (
            <div className="boq-detail-block">
              <h4>What we corrected automatically</h4>
              <ul className="boq-corrections">
                {item.corrections.map((entry, index) => (
                  <li key={index}><strong>{entry.field}</strong>: {String(entry.original)} → {String(entry.corrected)} <em>({entry.reason})</em></li>
                ))}
              </ul>
            </div>
          )}
          {[...(item.checks || []).map((check) => check.message), ...(item.warnings || [])].length > 0 && (
            <div className="boq-detail-block">
              <h4>Technical notes</h4>
              <ul className="boq-corrections">
                {[...(item.checks || []).map((entry) => entry.message), ...(item.warnings || [])].map((text, index) => <li key={index}>{text}</li>)}
              </ul>
            </div>
          )}
          <button type="button" className="danger-btn" onClick={onRemove}><Icon name="trash" size={16} /> Remove this row</button>
        </div>
      )}
    </div>
  )
}

/**
 * Step 2: check the rows. Parent callbacks persist to the server and
 * return the updated document (or null on failure; the parent shows why).
 */
export default function BoqCheck({ doc, scan, isPdf, onAttachScan, saveItems, acceptRows, confirmDoc, busy }) {
  const items = useMemo(() => doc.items || [], [doc.items])
  const priced = useMemo(() => hasPriceColumns(items), [items])
  const phone = useIsPhone()
  const counts = useMemo(() => {
    const statuses = items.map(rowStatus)
    return {
      total: items.length,
      ok: statuses.filter((status) => status === 'ok').length,
      fix: statuses.filter((status) => status === 'fix').length,
      glance: statuses.filter((status) => status === 'glance').length,
      attention: statuses.filter((status) => status === 'fix' || status === 'glance').length,
      resolved: items.filter((item) => item.fixed || item.acceptance).length,
    }
  }, [items])
  const [filter, setFilter] = useState(() => ((doc.items || []).some((item) => rowStatus(item) === 'fix') ? 'fix' : 'quote'))
  const [search, setSearch] = useState('')
  const [showOk, setShowOk] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draftState, setDraftState] = useState(null)
  const [toast, setToast] = useState(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const listRef = useRef(null)
  const toastTimer = useRef(null)

  const timedOut = items.filter((item) => rowStatus(item) === 'glance' && (item.reviewNotes || []).some((note) => note.code === 'ai_timeout')).length
  const filterDef = FILTERS.find((entry) => entry.id === filter) || FILTERS[0]
  const visible = useMemo(() => items.filter((item) => filterDef.test(item) && matchesSearch(item, search)), [items, filterDef, search])
  const collapsedOk = filter === 'all' && !search && !showOk
  const listed = collapsedOk ? visible.filter((item) => rowStatus(item) !== 'ok') : visible
  const hiddenOk = visible.length - listed.length
  const pages = useMemo(() => [...new Set(items.map(pageOf).filter((page) => page !== null))].sort((a, b) => a - b), [items])
  // On a wide screen the first row of the view is open from the start.
  const activeId = selectedId ?? (phone ? null : listed[0]?.lineItemId ?? null)
  const selected = items.find((item) => item.lineItemId === activeId) || null
  // The draft belongs to one row and its saved values; a save resets it.
  const draftKey = selected ? [selected.lineItemId, selected.quantity, selected.rate, selected.amount, selected.unit].join('|') : ''
  const draft = selected ? (draftState?.key === draftKey ? draftState.values : draftOf(selected)) : null
  const setDraft = (values) => setDraftState({ key: draftKey, values })

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const showToast = (text, undo) => {
    window.clearTimeout(toastTimer.current)
    setToast({ text, undo })
    toastTimer.current = window.setTimeout(() => setToast(null), 10000)
  }

  const scrollRowIntoView = (id) => {
    window.requestAnimationFrame(() => {
      const node = listRef.current?.querySelector(`[data-id="${CSS.escape(String(id))}"]`)
      node?.scrollIntoView({ block: 'nearest' })
    })
  }

  const select = (item, { openSheet = true } = {}) => {
    if (!item) return
    setSelectedId(item.lineItemId)
    if (phone && openSheet) setSheetOpen(true)
    scrollRowIntoView(item.lineItemId)
  }

  const goNextProblem = (list = items, fromId = activeId) => {
    const next = nextProblemIn(list, fromId)
    if (!next) {
      showToast('Nothing left to check. You can confirm the BOQ.', null)
      return
    }
    const nextStatus = rowStatus(next)
    const inView = FILTERS.find((entry) => entry.id === filter)?.test(next) && matchesSearch(next, search)
    if (!inView) { setFilter(nextStatus === 'fix' ? 'fix' : 'glance'); setSearch('') }
    select(next)
  }

  const persist = async (nextItems, options, label, undoOptions) => {
    const before = items
    const saved = await saveItems(nextItems, options)
    if (!saved) return null
    showToast(label, async () => {
      setToast(null)
      await saveItems(before, undoOptions)
    })
    return saved
  }

  const saveRow = async () => {
    if (!selected || !draft) return
    const dirty = draftDirty(selected, draft)
    const status = rowStatus(selected)
    if (!dirty && status !== 'glance') { goNextProblem(); return }
    const check = checkNumbers(draft, priced)
    const updated = applyDraft(selected, draft)
    const nextItems = items.map((item) => (item.lineItemId === selected.lineItemId ? updated : item))
    // Saving a row in the editor means "I have looked at it": glance notes
    // are cleared when the numbers are consistent. Wrong numbers stay red.
    const accept = check.ok && (selected.reviewNotes || []).some((note) => note.severity === 'glance') ? [{ lineItemId: selected.lineItemId, reason: dirty ? 'Checked and corrected' : 'Looks fine' }] : []
    const label = `S.No ${selected.serialNumber || '?'} ${dirty ? 'saved' : 'marked as fine'}${dirty && !check.ok ? ' (numbers still disagree)' : ''}.`
    const saved = await persist(nextItems, { accept }, label, { unaccept: accept.map((entry) => entry.lineItemId) })
    if (saved) goNextProblem(saved.items, selected.lineItemId)
  }

  const looksFine = async () => {
    if (!selected) return
    const before = items
    const saved = await acceptRows([selected.lineItemId], 'Looks fine')
    if (!saved) return
    const id = selected.lineItemId
    showToast(`S.No ${selected.serialNumber || '?'} marked as fine.`, async () => { setToast(null); await saveItems(before, { unaccept: [id] }) })
    goNextProblem(saved.items, id)
  }

  const keepAsIs = async (reason) => {
    if (!selected) return
    const updated = applyDraft(selected, draft)
    const nextItems = items.map((item) => (item.lineItemId === selected.lineItemId ? updated : item))
    const saved = await persist(nextItems, { accept: [{ lineItemId: selected.lineItemId, reason }] }, `S.No ${selected.serialNumber || '?'} kept as is.`, { unaccept: [selected.lineItemId] })
    if (saved) goNextProblem(saved.items, selected.lineItemId)
  }

  const changeFields = (changes) => {
    // Text fields (code, size, description): saved quietly, no next jump.
    const nextItems = items.map((item) => (item.lineItemId === selected.lineItemId ? { ...item, ...changes } : item))
    saveItems(nextItems, { quiet: true })
  }

  const removeRow = async () => {
    if (!selected || !window.confirm(`Remove S.No ${selected.serialNumber || 'this row'} from the BOQ?`)) return
    const index = items.findIndex((item) => item.lineItemId === selected.lineItemId)
    const nextItems = items.filter((item) => item.lineItemId !== selected.lineItemId)
    const saved = await persist(nextItems, {}, `S.No ${selected.serialNumber || '?'} removed.`, {})
    if (saved) {
      setSheetOpen(false)
      setSelectedId(saved.items[Math.min(index, saved.items.length - 1)]?.lineItemId || null)
    }
  }

  const addRow = async () => {
    const id = `user-${Date.now()}`
    const saved = await saveItems([...items, { lineItemId: id, serialNumber: '', description: 'New line', quantity: null, unit: '', rate: null, amount: null, provenance: {} }], {})
    if (saved) { setFilter('all'); setShowOk(true); select(saved.items.find((item) => item.lineItemId === id)) }
  }

  // Moving to another row keeps typed numbers: they are saved first.
  const openRow = async (item) => {
    if (selected && draft && draftDirty(selected, draft) && item.lineItemId !== selected.lineItemId) {
      const nextItems = items.map((row) => (row.lineItemId === selected.lineItemId ? applyDraft(row, draft) : row))
      await saveItems(nextItems, { quiet: true })
    }
    select(item)
  }

  const bulkAccept = async () => {
    const ids = items.filter((item) => rowStatus(item) === 'glance').map((item) => item.lineItemId)
    setBulkOpen(false)
    if (!ids.length) return
    const before = items
    const saved = await acceptRows(ids, 'Looks fine (accepted together)')
    if (saved && filter === 'glance') setFilter(saved.items.some((item) => rowStatus(item) === 'fix') ? 'fix' : 'quote')
    if (saved) showToast(`${ids.length} rows marked as fine.`, async () => { setToast(null); await saveItems(before, { unaccept: ids }) })
  }

  const confirm = async ({ acceptGlance = false } = {}) => {
    setConfirmOpen(false)
    if (acceptGlance) {
      const ids = items.filter((item) => rowStatus(item) === 'glance').map((item) => item.lineItemId)
      if (ids.length && !(await acceptRows(ids, 'Looks fine (accepted together)'))) return
    }
    await confirmDoc()
  }

  const onListKeyDown = (event) => {
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const index = listed.findIndex((item) => item.lineItemId === activeId)
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); openRow(listed[Math.min(listed.length - 1, index + 1)] || listed[0]) }
    if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); openRow(listed[Math.max(0, index - 1)] || listed[0]) }
    if (event.key === 'n' || event.key === 'N') { event.preventDefault(); goNextProblem() }
    if (event.key === 'Enter' && selected && event.target.closest('.boq-list')) {
      event.preventDefault()
      document.querySelector('.boq-editor .boq-fields input')?.focus()
    }
  }

  const jumpToPage = (value) => {
    const page = Number(value)
    const first = items.find((item) => pageOf(item) === page)
    if (!first) return
    setFilter('all'); setSearch(''); setShowOk(true)
    select(first)
  }

  const filterCount = (entry) => items.filter(entry.test).length
  const editor = selected && draft ? (
    <RowEditor
      key={selected.lineItemId}
      item={selected}
      priced={priced}
      draft={draft}
      setDraft={setDraft}
      onSave={saveRow}
      onLooksFine={looksFine}
      onKeep={keepAsIs}
      onCancel={() => setDraft(draftOf(selected))}
      onRemove={removeRow}
      onFieldsChange={changeFields}
      busy={busy}
      scan={scan}
      isPdf={isPdf}
      onAttachScan={onAttachScan}
      onClose={() => setSheetOpen(false)}
      phone={phone}
    />
  ) : null

  return (
    <div className="boq-check" onKeyDown={onListKeyDown}>
      <SummaryCard items={items} validation={doc.extraction_metadata?.validation} counts={counts} onNext={() => goNextProblem()} nextAvailable={counts.attention > 0} />

      {timedOut > 0 && (
        <div className="notice info" role="status">
          Some rows need a quick look because we ran out of time checking them. Your data is safe. ({timedOut} {timedOut === 1 ? 'row' : 'rows'})
        </div>
      )}

      <QuotationLines items={items} selectedId={activeId} onOpen={(item) => {
        if (!filterDef.test(item) || !matchesSearch(item, search)) { setFilter('quote'); setSearch('') }
        openRow(item)
      }} />

      <div className="boq-workspace">
        <section className="panel boq-list-panel" aria-label="BOQ rows">
          <div className="boq-filters" role="group" aria-label="Show rows">
            {FILTERS.map((entry) => (
              <button key={entry.id} type="button" className={`boq-filter filter-${entry.id}${filter === entry.id ? ' active' : ''}`} aria-pressed={filter === entry.id} onClick={() => { setFilter(entry.id); if (entry.id === 'ok') setShowOk(true) }}>
                {entry.label} <span className="mono boq-filter-count">{filterCount(entry)}</span>
              </button>
            ))}
          </div>
          <div className="boq-tools">
            <label className="boq-search">
              <Icon name="search" size={16} />
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search S.No, code or description" aria-label="Search rows by S.No, code or description" />
            </label>
            {pages.length > 1 && (
              <label className="boq-page-jump">
                <span>Page</span>
                <select value="" onChange={(event) => jumpToPage(event.target.value)} aria-label="Jump to a page">
                  <option value="">Go to…</option>
                  {pages.map((page) => <option key={page} value={page}>Page {page}</option>)}
                </select>
              </label>
            )}
            {counts.glance > 0 && (
              <button type="button" className="secondary-btn" onClick={() => setBulkOpen(true)} disabled={busy}>
                <Icon name="check-circle" size={16} /> Accept all amber rows ({counts.glance})
              </button>
            )}
          </div>

          <ol className="boq-list" ref={listRef} tabIndex={-1} aria-label={`${filterDef.label}: ${listed.length} rows`}>
            {listed.map((item) => {
              const status = rowStatus(item)
              const reason = ['fix', 'glance'].includes(status) ? mainReason(item) : ''
              return (
                <li key={item.lineItemId} data-id={item.lineItemId}>
                  <button
                    type="button"
                    className={`boq-row status-${status}${item.lineItemId === activeId ? ' selected' : ''}`}
                    aria-current={item.lineItemId === activeId ? 'true' : undefined}
                    onClick={() => openRow(item)}
                  >
                    <StatusChip status={status} compact />
                    <span className="boq-row-sno mono" aria-label={`S.No ${item.serialNumber || 'unknown'}`}>{item.serialNumber || '—'}</span>
                    <span className="boq-row-main">
                      <span className="boq-row-desc">{item.description || item.product || 'No description'}</span>
                      {reason && <span className="boq-row-reason">{reason}</span>}
                      {item.acceptance && status !== 'ok' && <span className="boq-row-reason is-muted">{item.acceptance.reason}</span>}
                    </span>
                    <span className="boq-row-nums mono">
                      <span>{formatIN(item.quantity)} {item.unit || ''}</span>
                      {priced && <small>{formatMoney(item.amount)}</small>}
                    </span>
                    <span className="boq-row-tags">
                      {item.forQuotation && <span className="boq-tag" title="Goes to the quotation">Pipe</span>}
                      {item.fixed && <span className="boq-tag is-fixed">Fixed</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          {!listed.length && (
            <div className="empty-preview boq-empty">
              {search ? 'No rows match your search.'
                : filter === 'fix' ? <><Icon name="check-circle" size={22} /> No wrong numbers left.</>
                  : filter === 'glance' ? <><Icon name="check-circle" size={22} /> Nothing left to glance at.</>
                    : filter === 'fixed' ? 'Rows you correct or mark as fine appear here.'
                      : 'No rows here.'}
            </div>
          )}
          {hiddenOk > 0 && (
            <button type="button" className="ghost-btn boq-show-ok" onClick={() => setShowOk(true)}>
              <Icon name="check-circle" size={16} /> Show {hiddenOk} OK rows
            </button>
          )}
          <button type="button" className="ghost-btn" onClick={addRow} disabled={busy}><Icon name="plus" size={16} /> Add a row</button>
        </section>

        {!phone && (
          <aside className="panel boq-editor-panel" aria-label={selected ? `Row S.No ${selected.serialNumber || ''}` : 'Row details'}>
            {editor || <div className="empty-preview">Choose a row on the left to check it against the scan.</div>}
          </aside>
        )}
      </div>

      {phone && sheetOpen && editor && (
        <Modal onClose={() => setSheetOpen(false)} labelledBy="boq-editor-title" className="boq-sheet">
          {editor}
        </Modal>
      )}

      <div className={`panel boq-confirm-bar${counts.fix ? ' is-blocked' : ''}`}>
        {counts.fix > 0 ? (
          <p role="status"><Icon name="x-circle" size={18} /> <strong>{counts.fix} {counts.fix === 1 ? 'item still has' : 'items still have'} wrong numbers.</strong> <button type="button" className="link-btn" onClick={() => { setFilter('fix'); setSearch(''); select(items.find((item) => rowStatus(item) === 'fix')) }}>Show {counts.fix === 1 ? 'it' : 'them'}</button></p>
        ) : counts.glance > 0 ? (
          <p role="status"><Icon name="eye" size={18} /> No wrong numbers. {counts.glance} {counts.glance === 1 ? 'row has' : 'rows have'} a small note to glance at.</p>
        ) : (
          <p role="status"><Icon name="check-circle" size={18} /> Everything is checked. You can confirm the BOQ.</p>
        )}
        <button type="button" className="primary-btn boq-big-btn" disabled={busy || counts.fix > 0} onClick={() => (counts.glance ? setConfirmOpen(true) : confirm())}>
          <Icon name="check-circle" size={18} /> Confirm BOQ
        </button>
      </div>

      {bulkOpen && (
        <Modal onClose={() => setBulkOpen(false)} labelledBy="boq-bulk-title">
          <h2 id="boq-bulk-title">Accept {counts.glance} amber rows?</h2>
          <p>These rows only have a small note (for example a unit we filled in, or a row we ran out of time to double-check). Their numbers add up.</p>
          <p className="file-note">Rows with wrong numbers{counts.fix ? ` (${counts.fix})` : ''} are never included. You can undo this.</p>
          <div className="button-row">
            <button type="button" className="primary-btn" onClick={bulkAccept}>Accept {counts.glance} rows</button>
            <button type="button" className="secondary-btn" onClick={() => setBulkOpen(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {confirmOpen && (
        <Modal onClose={() => setConfirmOpen(false)} labelledBy="boq-confirm-title">
          <h2 id="boq-confirm-title">Confirm the BOQ?</h2>
          <p>{counts.glance} {counts.glance === 1 ? 'row still has' : 'rows still have'} a small note. Their numbers add up. They will be marked as fine when you confirm.</p>
          <div className="button-row">
            <button type="button" className="primary-btn" onClick={() => confirm({ acceptGlance: true })}>Accept them and confirm</button>
            <button type="button" className="secondary-btn" onClick={() => { setConfirmOpen(false); setFilter('glance') }}>Let me look first</button>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="boq-toast" role="status" aria-live="polite">
          <Icon name="check-circle" size={17} />
          <span>{toast.text}</span>
          {toast.undo && <button type="button" className="secondary-btn" onClick={toast.undo}>Undo</button>}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="close" size={16} /></button>
        </div>
      )}
    </div>
  )
}
