// Shared helpers for the BOQ "Check" step: Indian number formatting,
// plain-language reasons for each row, the live qty × rate = amount check
// used while editing, and the row filters. The server decides the stored
// severity (backend/src/documents/boqReviewState.js); this file mirrors the
// number check only, so the editor can show a tick or a mismatch live.

const TOLERANCE = 1 // rupees, same as the server

/** "1,23,45,678.90" — Indian grouping, up to 2 decimals (always 2 for money). */
export function formatIN(value, { money = false } = {}) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return number.toLocaleString('en-IN', { minimumFractionDigits: money ? 2 : 0, maximumFractionDigits: 2 })
}

export const formatMoney = (value) => (value === null || value === undefined || value === '' ? '—' : `Rs ${formatIN(value, { money: true })}`)

/** A typed number ("3,12,550.68", " 42.78 ") or null. */
export function parseNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).replace(/,/g, '').replace(/^rs\.?\s*/i, '').trim()
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null
  return Number(text)
}

export const round2 = (value) => Math.round(value * 100) / 100

export function hasPriceColumns(items = []) {
  return items.some((item) => parseNumber(item.rate) !== null || parseNumber(item.amount) !== null
    || String(item.ocr?.rate || '').trim() || String(item.ocr?.amount || '').trim())
}

/**
 * The numbers check for a row as typed: { ok, code, computed, ... }.
 * Mirrors numberProblem() on the server.
 */
export function checkNumbers(row, priced = true) {
  const quantity = parseNumber(row.quantity)
  const rate = parseNumber(row.rate)
  const amount = parseNumber(row.amount)
  const base = { quantity, rate, amount, computed: quantity !== null && rate !== null ? round2(quantity * rate) : null }
  if (quantity === null && rate === null && amount === null) return { ...base, ok: true, code: 'no_numbers' }
  if (quantity === null) return { ...base, ok: false, code: 'quantity_missing' }
  if (quantity <= 0) return { ...base, ok: false, code: 'quantity_impossible' }
  if (!priced) return { ...base, ok: true, code: 'ok' }
  if (rate === null && amount === null) return { ...base, ok: false, code: 'rate_amount_missing' }
  if (rate === null) return { ...base, ok: false, code: 'rate_missing' }
  if (amount === null) return { ...base, ok: false, code: 'amount_missing' }
  if (rate <= 0 || amount <= 0) return { ...base, ok: false, code: 'value_impossible' }
  if (Math.abs(base.computed - amount) > TOLERANCE) return { ...base, ok: false, code: 'amount_mismatch', difference: round2(amount - base.computed) }
  return { ...base, ok: true, code: 'ok' }
}

const FIELD_NAMES = { quantity: 'Quantity', rate: 'Rate', amount: 'Amount', unit: 'Unit', itemCode: 'Item code', serialNumber: 'S.No', size: 'Size', description: 'Description' }

/** One short plain-language sentence for a review note from the server. */
export function noteText(note, item = {}) {
  switch (note.code) {
    case 'amount_mismatch':
      return `Quantity × rate = ${formatIN(note.computed, { money: true })} but amount says ${formatIN(note.amount, { money: true })}.`
    case 'quantity_missing':
      return 'We could not read the quantity clearly — please check against the scan.'
    case 'rate_amount_missing':
      return 'We could not read the rate or the amount clearly — please check against the scan.'
    case 'rate_missing':
      return 'We could not read the rate clearly — please check against the scan.'
    case 'amount_missing':
      return `We could not read the amount. Quantity × rate would be ${formatIN(note.computed, { money: true })}.`
    case 'quantity_impossible':
      return 'The quantity cannot be zero or less.'
    case 'value_impossible':
      return 'Rate and amount must be more than zero.'
    case 'no_numbers':
      return 'No quantity, rate or amount on this line. Is it a heading?'
    case 'unit_guessed':
      return note.original && note.original !== '(blank)'
        ? `The unit was unclear on the scan ("${note.original}"); we used "${note.corrected}".`
        : `The unit was missing on the scan; we used "${note.corrected}".`
    case 'unit_missing':
      return 'The unit is missing.'
    case 'unit_unclear':
      return `The unit "${item.unit || ''}" is unclear on the scan.`
    case 'code_unclear':
      return `The item code reads "${item.itemCode || ''}" — it may be misread (for example 9.1.4).`
    case 'size_unclear':
      return 'The pipe size is not a standard size — check the description.'
    case 'rate_words':
      return 'The rate in figures and the rate in words do not match.'
    case 'ai_timeout':
      return 'We ran out of time double-checking this row — please glance at it.'
    case 'number_guessed':
      return `The ${(FIELD_NAMES[note.field] || note.field).toLowerCase()} was hard to read; we used ${formatIN(note.corrected)}.`
    case 'value_guessed':
      return `${FIELD_NAMES[note.field] || 'A value'} was hard to read; we used "${note.corrected}".`
    default:
      return 'Something looks unusual on this row — please glance at it.'
  }
}

/** Live note for a row being edited (numbers only). */
export function liveNumberText(check) {
  if (check.ok || check.code === 'no_numbers') return ''
  return noteText({ code: check.code, computed: check.computed, amount: check.amount }, {})
}

/**
 * The row's review status for the UI:
 *   fix      red    wrong numbers, not accepted
 *   kept     grey   wrong numbers, kept on purpose (accepted with a reason)
 *   glance   amber  please glance, not accepted
 *   checked  green  glance row marked "Looks fine"
 *   ok       green  nothing to look at
 */
export function rowStatus(item) {
  if (item.severity === 'error') return item.acceptance ? 'kept' : 'fix'
  if (item.severity === 'glance') return item.acceptance ? 'checked' : 'glance'
  return 'ok'
}

export const STATUS_LABEL = {
  fix: 'Wrong number',
  kept: 'Kept as is',
  glance: 'Please glance',
  checked: 'Looks fine',
  ok: 'OK',
}

export const STATUS_ICON = { fix: 'x-circle', kept: 'check', glance: 'eye', checked: 'check-circle', ok: 'check-circle' }

export const isUnresolved = (item) => ['fix', 'glance'].includes(rowStatus(item))

/** The first plain reason to show in the list (errors first). */
export function mainReason(item) {
  const notes = Array.isArray(item.reviewNotes) ? item.reviewNotes : []
  const note = notes.find((entry) => entry.severity === 'error') || notes[0]
  return note ? noteText(note, item) : ''
}

export const FILTERS = [
  { id: 'fix', label: 'Needs fixing', test: (item) => rowStatus(item) === 'fix' },
  { id: 'glance', label: 'Glance', test: (item) => rowStatus(item) === 'glance' },
  { id: 'quote', label: 'Pipes & stoneware', test: (item) => item.forQuotation },
  { id: 'fixed', label: 'Fixed by me', test: (item) => Boolean(item.fixed) || Boolean(item.acceptance) },
  { id: 'ok', label: 'OK', test: (item) => ['ok', 'checked', 'kept'].includes(rowStatus(item)) },
  { id: 'all', label: 'All', test: () => true },
]

export function matchesSearch(item, query) {
  const text = query.trim().toLowerCase()
  if (!text) return true
  return [item.serialNumber, item.itemCode, item.description, item.size, item.specification]
    .some((value) => String(value ?? '').toLowerCase().includes(text))
}

export function pageOf(item) {
  return item?.provenance?.page ?? null
}

/** Bounding box (0–1 page coordinates) of a row, or of its number cells only. */
export function rowBounds(item, { numbersOnly = false } = {}) {
  const cells = Array.isArray(item?.sourceCells) && item.sourceCells.length ? item.sourceCells : []
  const isNumberHeader = (header) => /\b(qty|quantity|rate|amount|rs)\b/i.test(String(header || '')) && !/\bwords?\b/i.test(String(header || ''))
  const boxes = []
  for (const cell of cells) {
    if (numbersOnly && !isNumberHeader(cell.header)) continue
    const points = cell.boundingBox?.points
    if (!Array.isArray(points) || !points.length) continue
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    boxes.push({ left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) })
  }
  if (!boxes.length && !numbersOnly) {
    for (const cell of item?.provenance?.cellBounds || []) if (cell.bounds) boxes.push(cell.bounds)
  }
  if (!boxes.length) return null
  // A little room around the OCR boxes so the outline never cuts the digits.
  return {
    left: Math.max(0, Math.min(...boxes.map((box) => box.left)) - 0.004),
    right: Math.min(1, Math.max(...boxes.map((box) => box.right)) + 0.004),
    top: Math.max(0, Math.min(...boxes.map((box) => box.top)) - 0.007),
    bottom: Math.min(1, Math.max(...boxes.map((box) => box.bottom)) + 0.007),
  }
}

export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
