import { normalizeMobile } from './technicianForm.js'

// Employee self-registration (EmployeeRegistrationPage) and the employee list
// (TechnicianStaffView). Mirrors backend/src/technician/employeeRegistration.js;
// the server validates again and allocates the Employee ID.

export const EMPLOYEE_FORM_PATH = '/employee-registration'

// The 28 states of India and their Employee ID codes (SEPL-TN001 …).
export const STATE_CODES = {
  'Andhra Pradesh': 'AP',
  'Arunachal Pradesh': 'AR',
  Assam: 'AS',
  Bihar: 'BR',
  Chhattisgarh: 'CG',
  Goa: 'GA',
  Gujarat: 'GJ',
  Haryana: 'HR',
  'Himachal Pradesh': 'HP',
  Jharkhand: 'JH',
  Karnataka: 'KA',
  Kerala: 'KL',
  'Madhya Pradesh': 'MP',
  Maharashtra: 'MH',
  Manipur: 'MN',
  Meghalaya: 'ML',
  Mizoram: 'MZ',
  Nagaland: 'NL',
  Odisha: 'OD',
  Punjab: 'PB',
  Rajasthan: 'RJ',
  Sikkim: 'SK',
  'Tamil Nadu': 'TN',
  Telangana: 'TS',
  Tripura: 'TR',
  'Uttar Pradesh': 'UP',
  Uttarakhand: 'UK',
  'West Bengal': 'WB',
}
export const EMPLOYEE_STATES = Object.keys(STATE_CODES)

export const EMPLOYEE_INITIAL_VALUES = { full_name: '', mobile: '', state: '', email: '' }
export const EMPLOYEE_FIELD_ORDER = ['full_name', 'mobile', 'state', 'email']

export const EMPLOYEE_SOURCE_META = {
  self: { label: 'Self-registered', tone: 'success' },
  manual: { label: 'Added manually', tone: 'neutral' },
}

/** Error text for one field ('' when fine). Same rules and wording as the server. */
export function validateEmployeeField(key, values) {
  const value = String(values[key] ?? '')
  switch (key) {
    case 'full_name': {
      const name = value.replace(/\s+/g, ' ').trim()
      if (!name) return 'Enter your full name.'
      if (name.length < 2 || name.length > 120) return 'Your name must be 2–120 characters.'
      return /\p{L}/u.test(name) && !/[<>{}\\]/.test(name) ? '' : 'Enter your name using letters.'
    }
    case 'mobile': {
      const digits = normalizeMobile(value)
      if (!digits) return 'Enter your mobile number.'
      return /^[6-9][0-9]{9}$/.test(digits) ? '' : 'Enter a valid 10-digit Indian mobile number (starting with 6, 7, 8 or 9).'
    }
    case 'state':
      if (!value) return 'Choose your state of operation.'
      return STATE_CODES[value] ? '' : 'Choose a state from the list.'
    case 'email': {
      const email = value.trim()
      if (!email) return 'Enter your email address.'
      return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter a valid email address.'
    }
    default:
      return ''
  }
}

export function validateEmployeeForm(values) {
  return Object.fromEntries(EMPLOYEE_FIELD_ORDER.map((key) => [key, validateEmployeeField(key, values)]).filter(([, error]) => error))
}

/** The registration slip the employee downloads (plain text). */
export function registrationDetailsText({ employee, pin }, { issuedAt = new Date() } = {}) {
  const when = new Date(employee.registered_at || issuedAt)
  const date = Number.isNaN(when.getTime()) ? '' : when.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  return [
    'SUDARSHAN PIPES (SEPL)',
    'Employee Registration Details',
    '==============================',
    '',
    `Name               : ${employee.full_name}`,
    `Employee ID        : ${employee.employee_id}`,
    `State of Operation : ${employee.state}`,
    `Mobile Number      : ${employee.mobile_masked}`,
    `Initial PIN        : ${pin}`,
    date ? `Registered on      : ${date} (IST)` : null,
    '',
    'Keep this file private. Your initial PIN is the last 4 digits of your',
    'mobile number: treat it as temporary and do not share it. You may be',
    'asked to change it when you first sign in.',
    '',
  ].filter((line) => line !== null).join('\r\n')
}

/** Rows matching the employee list's search box and state filter (same as the export). */
export function filterEmployees(rows, { q = '', state = '' } = {}) {
  const needle = String(q).trim().toLowerCase()
  const digits = needle.replace(/\D/g, '')
  return rows.filter((row) => (!state || row.state === state)
    && (!needle
      || [row.staff_code, row.full_name, row.state, row.email].some((value) => String(value || '').toLowerCase().includes(needle))
      || (digits.length >= 3 && String(row.phone || '').includes(digits))))
}
