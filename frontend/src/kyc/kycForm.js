// Vendor KYC form definition — labels, options and validation for the
// public form (VendorKycPage) and the staff view (KycSubmissionsView).
//
// Mirrors backend/src/kyc/kycSchema.js, which is the authority: these
// checks only give vendors instant feedback; the server re-validates
// everything and its per-field messages are shown the same way.

export const BUSINESS_TYPES = ['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'Trust / Society', 'Other']
export const ACCOUNT_TYPES = ['Current', 'Savings', 'Cash Credit', 'Overdraft', 'Other']
export const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
]

// Section 3 cascading picker (CategoryPicker): real items per category.
// "Other (type it in)" is appended to every list, the "Other" category's
// included, and reveals a text box. Keep in step with CATEGORY_OPTIONS in
// backend/src/kyc/kycSchema.js, which rejects anything not listed there.
// Sent as category_selections
// (toCategorySelections) and stored in kyc_submissions.category_selections.
export const OTHER_ITEM = 'Other'
export const CATEGORY_OPTIONS = [
  { key: 'raw_materials', label: 'Raw Materials', items: ['PVC Resin', 'Titanium Dioxide', 'Iron Oxide', 'Calcium Carbonate (Omyacarb)', 'Flowaid / Processing Aids', 'Cooling Tower & Descaling Chemicals'] },
  { key: 'components_fittings', label: 'Components & Fittings', items: ['Pipe End Caps', 'Thread Adaptors', 'SS Hose Nipples', 'Aluminium Channel', 'Gear Box / Mechanical Components'] },
  { key: 'machinery_spares', label: 'Machinery & Spares', items: ['Granulator Blades', 'Cutting / Coupler Machines'] },
  { key: 'packaging', label: 'Packaging', items: ['Packing Bags / Sacks', 'Printing Ink & Make-up', 'Filter Kits / Consumables'] },
  { key: 'transport_logistics', label: 'Transport & Logistics', items: ['Freight / Transport Services', 'Warehousing'] },
  { key: 'contractor_services', label: 'Contractor & Services', items: ['Annual Maintenance Contracts (AMC)', 'Lab / Sample Testing Services', 'Installation & Commissioning Services'] },
  { key: 'maintenance', label: 'Maintenance', items: ['CNC Maintenance', 'Extruder/Motor Repairs Maintenance', 'Generator Maintenance', 'Air Compressor Maintenance', 'CNC Consumables'] },
  { key: 'other', label: 'Other', items: ['Office Stationaries'] },
]

/** "maintenance item" / "item" for the Other category. */
const itemNoun = (category) => (category.key === 'other' ? 'item' : `${category.label.toLowerCase()} item`)

/** Picker value → stored shape, in form order. */
export function toCategorySelections(value) {
  return CATEGORY_OPTIONS.filter((category) => value[category.key]).map((category) => ({
    category: category.label,
    items: [...value[category.key].items],
    other_text: value[category.key].other ? value[category.key].other_text.trim() : '',
  }))
}

/** Errors for the picker: { categories?, category_<key>? }. */
export function validateCategorySelections(value) {
  const errors = {}
  const chosen = CATEGORY_OPTIONS.filter((category) => value[category.key])
  if (!chosen.length) errors.categories = 'Tick at least one category.'
  for (const category of chosen) {
    const entry = value[category.key]
    if (entry.other && !entry.other_text.trim()) {
      errors[`category_${category.key}`] = 'Type the other item, or remove “Other”.'
    } else if (!entry.items.length && !entry.other) {
      errors[`category_${category.key}`] = `Pick at least one ${itemNoun(category)}, or untick the category.`
    }
  }
  return errors
}

export const DOCUMENTS = [
  { key: 'pan_proof', label: 'PAN proof applicable to the business', mandatory: true },
  { key: 'gst_certificate', label: 'GST Registration Certificate', mandatory: true },
  { key: 'bank_proof', label: 'Cancelled Cheque / Bank Proof', mandatory: true },
  { key: 'udyam_certificate', label: 'Udyam / MSME Certificate', mandatory: true },
  { key: 'signed_declaration', label: 'Signed & Sealed Declaration Page', mandatory: true, help: 'Print the declaration (button in section 6), sign it, stamp it with your company seal, then upload a scan or clear photo.' },
  { key: 'business_registration', label: 'Business registration proof (as applicable)', mandatory: false },
  { key: 'signatory_proof', label: 'Authorized signatory proof / authorization, if applicable', mandatory: false },
]
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png'
export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024

export const INTERNAL_CHECKS = [
  { key: 'business_identity', label: 'Business identity and registration checked' },
  { key: 'pan_gst', label: 'PAN / GST details checked, as applicable' },
  { key: 'bank', label: 'Bank account name and proof checked independently' },
  { key: 'technical', label: 'Technical / quality documents reviewed, if applicable' },
  { key: 'risk', label: 'Vendor risk / references reviewed, if required' },
]
export const CHECK_STATUSES = [
  { value: 'verified', label: 'Verified' },
  { value: 'pending', label: 'Pending' },
  { value: 'na', label: 'N/A' },
]
export const FINAL_DECISIONS = [
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'info_required', label: 'Further information required' },
]
export const STATUS_META = {
  pending: { label: 'Pending', tone: 'warning' },
  verified: { label: 'Verified', tone: 'cold' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  info_required: { label: 'Info required', tone: 'warm' },
}

export const DECLARATION_TEXT = 'I/We declare that the information provided in this form and the supporting documents are true, complete and current to the best of my/our knowledge. '
  + 'I/We agree to notify Sudarshan Extrusions Pvt. Ltd. of any material change in business, tax, address, ownership or bank details. '
  + 'Submission of this form does not by itself guarantee vendor approval or placement of an order.'
export const CONSENT_TEXT = 'I confirm the above information is true and complete, and I am authorized to submit this on behalf of the business.'

// ── Fields, in form order ─────────────────────────────────────────────
// kind: text | textarea | select | code | digits | mobile | phone | email | url | int
// wide: spans both columns of the form grid.
export const FIELDS = {
  // §1
  legal_name: { label: 'Legal Business / Vendor Name', required: true, max: 200, autoComplete: 'organization' },
  business_type: { label: 'Business Type', required: true, kind: 'select', options: BUSINESS_TYPES },
  trade_name: { label: 'Trade Name (if different)', max: 200 },
  pan: { label: 'PAN', required: true, kind: 'code', max: 10, pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/, hint: 'Enter the 10-character PAN, e.g. ABCDE1234F.', placeholder: 'ABCDE1234F' },
  gstin: { label: 'GSTIN', required: true, kind: 'code', max: 15, pattern: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, hint: 'Enter the 15-character GSTIN, e.g. 29ABCDE1234F1Z5.', placeholder: '29ABCDE1234F1Z5' },
  udyam_number: { label: 'Udyam / MSME No.', required: true, kind: 'code', max: 19, pattern: /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/, hint: 'Enter the Udyam number as UDYAM-XX-00-0000000.', placeholder: 'UDYAM-KA-00-0000000' },
  registered_address: { label: 'Registered Address', required: true, kind: 'textarea', max: 500, wide: true, autoComplete: 'street-address' },
  registered_pin: { label: 'PIN Code', required: true, kind: 'digits', max: 6, pattern: /^[1-9][0-9]{5}$/, hint: 'Enter the 6-digit PIN code.', autoComplete: 'postal-code' },
  state: { label: 'State', required: true, kind: 'select', options: STATES },
  factory_address: { label: 'Factory / Warehouse Address', kind: 'textarea', max: 500, wide: true },
  website: { label: 'Website', kind: 'url', max: 200, placeholder: 'www.example.com' },
  years_in_business: { label: 'Years in Business', required: true, kind: 'int', min: 0, maxValue: 200 },
  // §2
  contact_name: { label: 'Primary Contact Person', required: true, max: 120, autoComplete: 'name' },
  contact_designation: { label: 'Designation', required: true, max: 120, autoComplete: 'organization-title' },
  contact_mobile: { label: 'Mobile Number', required: true, kind: 'mobile', placeholder: '98765 43210', autoComplete: 'tel-national' },
  contact_email: { label: 'Official Email', required: true, kind: 'email', max: 254, autoComplete: 'email' },
  alternate_contact: { label: 'Alternate Contact', max: 200, placeholder: 'Name and phone number' },
  landline: { label: 'Landline (if any)', kind: 'phone', placeholder: '0831-2400000' },
  // §3
  products_offered: { label: 'Products / Services Offered', kind: 'textarea', max: 2000, wide: true, placeholder: 'Anything you supply that the categories above do not cover' },
  brands_specs: { label: 'Brands / Make / Specifications', kind: 'textarea', max: 2000, wide: true },
  supply_capacity: { label: 'Manufacturing / Supply Capacity', kind: 'textarea', max: 1000 },
  delivery_lead_time: { label: 'Delivery Locations / Lead Time', kind: 'textarea', max: 1000 },
  // §4
  bank_account_holder: { label: 'Account Holder Name', required: true, max: 200 },
  bank_name: { label: 'Bank Name', required: true, max: 200 },
  bank_account_number: { label: 'Account Number', required: true, kind: 'digits', max: 18, pattern: /^[0-9]{9,18}$/, hint: 'Enter the account number (9 to 18 digits).' },
  bank_account_number_confirm: { label: 'Confirm Account Number', required: true, kind: 'digits', max: 18 },
  bank_ifsc: { label: 'IFSC', required: true, kind: 'code', max: 11, pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/, hint: 'Enter the 11-character IFSC, e.g. SBIN0001234.', placeholder: 'SBIN0001234' },
  bank_branch: { label: 'Branch', required: true, max: 200 },
  bank_account_type: { label: 'Account Type', required: true, kind: 'select', options: ACCOUNT_TYPES },
  payment_terms: { label: 'Payment Terms Requested', max: 500, placeholder: 'e.g. 30 days from invoice' },
  currency: { label: 'Currency', kind: 'code', max: 3, pattern: /^[A-Z]{3}$/, hint: 'Enter a 3-letter currency code, e.g. INR.' },
  // §6
  authorized_person_name: { label: 'Authorized Person Name', required: true, max: 200 },
  authorized_person_designation: { label: 'Designation', required: true, max: 120 },
}

export const SECTIONS = [
  { number: 1, title: 'Vendor / Business Details', fields: ['legal_name', 'business_type', 'trade_name', 'pan', 'gstin', 'udyam_number', 'registered_address', 'registered_pin', 'state', 'factory_address', 'website', 'years_in_business'] },
  { number: 2, title: 'Contact Details', fields: ['contact_name', 'contact_designation', 'contact_mobile', 'contact_email', 'alternate_contact', 'landline'] },
  { number: 3, title: 'Vendor Category & Supply Details', fields: ['products_offered', 'brands_specs', 'supply_capacity', 'delivery_lead_time'] },
  { number: 4, title: 'Bank & Payment Details', fields: ['bank_account_holder', 'bank_name', 'bank_account_number', 'bank_account_number_confirm', 'bank_ifsc', 'bank_branch', 'bank_account_type', 'payment_terms', 'currency'] },
]

export const INITIAL_VALUES = {
  ...Object.fromEntries(Object.keys(FIELDS).map((key) => [key, ''])),
  currency: 'INR',
  category_selections: {},
  declaration_accepted: false,
}

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export function gstinChecksumValid(gstin) {
  let sum = 0
  for (let index = 0; index < 14; index++) {
    const product = GST_CHARS.indexOf(gstin[index]) * (index % 2 ? 2 : 1)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GST_CHARS[(36 - (sum % 36)) % 36] === gstin[14]
}

/** Value as the server will store it — used for checks and display. */
export function normalizeValue(key, raw) {
  const kind = FIELDS[key]?.kind || 'text'
  const text = String(raw ?? '')
  if (kind === 'code') return text.replace(/\s+/g, '').toUpperCase()
  if (kind === 'digits') return text.replace(/[\s-]/g, '')
  if (kind === 'mobile') {
    let digits = text.replace(/\D/g, '')
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
    return digits
  }
  if (kind === 'textarea') return text.trim()
  return text.replace(/\s+/g, ' ').trim()
}

/** Error message for one field ('' when valid). */
export function validateField(key, values) {
  const field = FIELDS[key]
  if (!field) return ''
  const value = normalizeValue(key, values[key])
  if (!value) {
    if (key === 'currency') return ''
    return field.required ? `${field.label} is required.` : ''
  }
  if (field.max && value.length > field.max) return `${field.label} must be ${field.max} characters or fewer.`
  if (field.pattern && !field.pattern.test(value)) return field.hint || `${field.label} is not valid.`
  switch (field.kind) {
    case 'mobile': return /^[6-9][0-9]{9}$/.test(value) ? '' : 'Enter a 10-digit Indian mobile number, e.g. 9876543210.'
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? '' : 'Enter a valid email address.'
    case 'phone': {
      const digits = value.replace(/\D/g, '').length
      return /^[0-9+\-() ]+$/.test(value) && digits >= 6 && digits <= 15 ? '' : 'Enter a landline number with STD code, e.g. 0831-2400000.'
    }
    case 'url': return /^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)+(\/\S*)?$/i.test(value) ? '' : 'Enter a website address like www.example.com.'
    case 'int': {
      if (!/^\d+$/.test(value)) return `${field.label} must be a whole number.`
      const number = Number(value)
      return number < field.min || number > field.maxValue ? `${field.label} must be between ${field.min} and ${field.maxValue}.` : ''
    }
    case 'select': return field.options.includes(value) ? '' : `Choose a ${field.label.toLowerCase()} from the list.`
    default: break
  }
  if (key === 'gstin') {
    if (!gstinChecksumValid(value)) return 'This GSTIN is not valid. Please check it against your GST certificate.'
    const pan = normalizeValue('pan', values.pan)
    if (FIELDS.pan.pattern.test(pan) && value.slice(2, 12) !== pan) return 'Characters 3 to 12 of the GSTIN must match the PAN. Please check both.'
  }
  if (key === 'bank_account_number_confirm' && value !== normalizeValue('bank_account_number', values.bank_account_number)) {
    return 'Account numbers do not match.'
  }
  return ''
}

/** Error message for one chosen file ('' when valid or optional+empty). */
export function validateDocument(document, file) {
  if (!file) return document.mandatory ? `${document.label} is mandatory.` : ''
  const ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase()
  if (!['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)) return 'Upload a PDF, JPG or PNG file.'
  if (file.size > DOCUMENT_MAX_BYTES) return 'Each file must be 5 MB or smaller.'
  if (file.size === 0) return 'This file is empty.'
  return ''
}

/** Every error on the form: { key: message }. */
export function validateForm(values, files) {
  const errors = {}
  for (const key of Object.keys(FIELDS)) {
    const message = validateField(key, values)
    if (message) errors[key] = message
  }
  Object.assign(errors, validateCategorySelections(values.category_selections || {}))
  for (const document of DOCUMENTS) {
    const message = validateDocument(document, files[document.key])
    if (message) errors[document.key] = message
  }
  if (!values.declaration_accepted) errors.declaration_accepted = 'Tick the confirmation to submit the form.'
  return errors
}

/** Order used to focus the first invalid field. */
export const FIELD_ORDER = [
  ...SECTIONS[0].fields, ...SECTIONS[1].fields,
  'categories', ...CATEGORY_OPTIONS.map((category) => `category_${category.key}`), ...SECTIONS[2].fields,
  ...SECTIONS[3].fields, ...DOCUMENTS.map((document) => document.key),
  'authorized_person_name', 'authorized_person_designation', 'declaration_accepted',
]

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** dd-mm-yyyy in India for a yyyy-mm-dd date or a timestamp. */
export function formatDate(value, { withTime = false } = {}) {
  if (!value) return ''
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  if (plain) return `${plain[3]}-${plain[2]}-${plain[1]}`
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const options = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }
  return new Intl.DateTimeFormat('en-GB', options).format(date).replace(/\//g, '-')
}

export function todayInIndia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
