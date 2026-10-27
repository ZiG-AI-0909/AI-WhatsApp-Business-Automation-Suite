import { apiFetch, apiFetchRaw } from '../api.js'

// Proforma Invoice Maker API (backend/src/routes/proforma.js). Totals,
// words and validation always come from the backend preview.

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const loadDefaults = () => apiFetch('/proforma/defaults')
export const previewInvoice = (invoice, signal) => apiFetch('/proforma/preview', { ...json({ invoice }), signal })
export const listInvoices = (search = '') => apiFetch(`/proforma?${new URLSearchParams(search ? { search } : {}).toString()}`)
export const getInvoice = (id) => apiFetch(`/proforma/${id}`)
export const createInvoice = (invoice) => apiFetch('/proforma', json({ invoice }))
export const updateInvoice = (id, invoice) => apiFetch(`/proforma/${id}`, { ...json({ invoice }), method: 'PUT' })
export const deleteInvoice = (id) => apiFetch(`/proforma/${id}`, { method: 'DELETE' })
export const saveProfile = (profile) => apiFetch('/proforma/profile', { ...json({ profile }), method: 'PUT' })
// Upload -> auto-fill: step 1 reads the file, step 2 extracts the fields.
// Separate requests with separate budgets; step 2 can be retried alone.
export function readInvoiceFile(file) {
  const body = new FormData()
  body.append('file', file)
  return apiFetch('/proforma/upload/ocr', { method: 'POST', body })
}
export const extractInvoiceFields = (text) => apiFetch('/proforma/upload/extract', json({ text }))
export const suggestNumber =(prefix, date) => apiFetch(`/proforma/next-number?${new URLSearchParams({ prefix, date }).toString()}`)

// Same rule as proformaExport.exportFileName: Proforma_Invoice_PI-03R5_2026-10-26.xlsx
export function exportFileName(invoice) {
  const number = String(invoice.invoice.number || 'draft').split('/').pop()
  const safe = number.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'draft'
  return `Proforma_Invoice_${safe}_${invoice.invoice.date || 'undated'}.xlsx`
}

// Downloads the workbook. A 422 carries { errors } for the form.
export async function exportInvoice(invoice) {
  const response = await apiFetchRaw('/proforma/export', json({ invoice }))
  if (!response.ok) {
    let data = {}
    try { data = await response.json() } catch { data = {} }
    const error = new Error(data.error || `Export failed (${response.status})`)
    error.status = response.status
    error.errors = data.errors || null
    throw error
  }
  const blob = await response.blob()
  const disposition = response.headers.get('Content-Disposition') || ''
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || exportFileName(invoice)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return fileName
}
