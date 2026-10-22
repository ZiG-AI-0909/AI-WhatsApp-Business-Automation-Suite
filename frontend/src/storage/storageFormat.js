// Shared helpers for the storage dashboard card, banner and Storage page.

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function formatPercent(value) {
  if (value === null || value === undefined) return '—'
  const rounded = Math.round(Number(value) * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`
}

const DATE_TIME = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date)
}

export function timeAgo(value) {
  if (!value) return 'never'
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

// Severity 0–4 from the backend (storageMonitor.SEVERITY). Status colours
// are reserved for status and always shown with a label and an icon.
export const SEVERITY_META = [
  { key: 'ok', label: 'Normal', tone: 'success', icon: 'check-circle', notice: null },
  { key: 'early', label: 'Early warning', tone: 'warning', icon: 'alert', notice: 'warning' },
  { key: 'high', label: 'High usage', tone: 'warning', icon: 'alert', notice: 'warning' },
  { key: 'critical', label: 'Critical', tone: 'danger', icon: 'alert', notice: 'error' },
  { key: 'full', label: 'Storage full', tone: 'danger', icon: 'x-circle', notice: 'error' },
]

export const severityMeta = (severity) => SEVERITY_META[Number(severity) || 0] || SEVERITY_META[0]

export const BUCKET_LABELS = {
  'campaign-media': 'Campaign attachments',
  'campaign-excel-uploads': 'Contact-list uploads',
  'knowledge-documents': 'Knowledge-base documents',
  'kyc-documents': 'Vendor KYC & partner documents',
}
export const bucketLabel = (bucket) => BUCKET_LABELS[bucket] || bucket
