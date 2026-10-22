// Mechanic / technician partner registration — options and validation for
// the public form (TechnicianRegistrationPage) and the staff view
// (TechnicianSubmissions).
//
// Mirrors backend/src/technician/technicianSchema.js, which is the
// authority: these checks only give instant feedback. Both return error
// CODES; technician/i18n.js turns them into English or Tamil sentences.

import { DOCUMENT_MAX_BYTES, todayInIndia } from '../kyc/kycForm.js'

// All 38 districts of Tamil Nadu — always this list, whichever state is chosen.
export const DISTRICTS = [
  'Ariyalur', 'Chengalpattu', 'Chennai', 'Coimbatore', 'Cuddalore', 'Dharmapuri', 'Dindigul', 'Erode',
  'Kallakurichi', 'Kancheepuram', 'Kanniyakumari', 'Karur', 'Krishnagiri', 'Madurai', 'Mayiladuthurai',
  'Nagapattinam', 'Namakkal', 'Nilgiris', 'Perambalur', 'Pudukkottai', 'Ramanathapuram', 'Ranipet', 'Salem',
  'Sivaganga', 'Tenkasi', 'Thanjavur', 'Theni', 'Thoothukudi', 'Tiruchirappalli', 'Tirunelveli', 'Tirupathur',
  'Tiruppur', 'Tiruvallur', 'Tiruvannamalai', 'Tiruvarur', 'Vellore', 'Viluppuram', 'Virudhunagar',
]
export const STATES = ['Tamil Nadu', 'Karnataka', 'Andhra Pradesh']

export const DOCUMENTS = [
  { key: 'aadhaar', label: 'Aadhaar Card', mandatory: false },
]
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png'
export { DOCUMENT_MAX_BYTES }

export const STATUS_META = {
  pending: { label: 'Pending', tone: 'warning' },
  shortlisted: { label: 'Shortlisted', tone: 'cold' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
}

// The 10 fields, in form order (aadhaar is the file upload).
export const FIELD_ORDER = ['full_name', 'district', 'place', 'mobile', 'address', 'pincode', 'state', 'date_of_birth', 'date_of_marriage', 'aadhaar']
export const REQUIRED = ['full_name', 'district', 'place', 'mobile', 'address', 'pincode', 'state', 'date_of_birth']

export const INITIAL_VALUES = {
  full_name: '', district: '', place: '', mobile: '', address: '', pincode: '', state: '', date_of_birth: '', date_of_marriage: '',
}

export function normalizeMobile(value) {
  let digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  return digits
}

function pastDateError(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || value < '1900-01-01') return 'invalid_date'
  return value > todayInIndia() ? 'future_date' : ''
}

/** Error code for one field ('' when valid). */
export function validateField(key, values) {
  const raw = values[key] ?? ''
  const value = key === 'address' ? String(raw).trim() : String(raw).replace(/\s+/g, ' ').trim()
  if (!value) return REQUIRED.includes(key) ? 'required' : ''
  switch (key) {
    case 'full_name': return value.length < 2 || value.length > 120 || !/\p{L}/u.test(value) ? 'invalid_name' : ''
    case 'district': return DISTRICTS.includes(value) ? '' : 'invalid_option'
    case 'state': return STATES.includes(value) ? '' : 'invalid_option'
    case 'place': return value.length > 120 ? 'too_long' : ''
    case 'address': return value.length > 500 ? 'too_long' : ''
    case 'mobile': return /^[6-9][0-9]{9}$/.test(normalizeMobile(value)) ? '' : 'invalid_mobile'
    case 'pincode': return /^[1-9][0-9]{5}$/.test(value.replace(/\s/g, '')) ? '' : 'invalid_pincode'
    case 'date_of_birth': return pastDateError(value)
    case 'date_of_marriage': {
      const error = pastDateError(value)
      if (error) return error
      return values.date_of_birth && !pastDateError(values.date_of_birth) && value < values.date_of_birth ? 'marriage_before_birth' : ''
    }
    default: return ''
  }
}

/** Error code for the optional Aadhaar file ('' when valid or empty). */
export function validateDocument(file) {
  if (!file) return ''
  const ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase()
  if (!['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)) return 'invalid_file'
  if (file.size > DOCUMENT_MAX_BYTES) return 'file_too_large'
  if (file.size === 0) return 'file_empty'
  return ''
}

/** Every error on the form: { key: code }. */
export function validateForm(values, files) {
  const errors = {}
  for (const key of Object.keys(INITIAL_VALUES)) {
    const code = validateField(key, values)
    if (code) errors[key] = code
  }
  const fileError = validateDocument(files.aadhaar)
  if (fileError) errors.aadhaar = fileError
  return errors
}

/** yyyy-mm-dd → DD/MM/YYYY */
export function formatDmy(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  return match ? `${match[3]}/${match[2]}/${match[1]}` : ''
}
