// Team & access — the areas a super admin can give an account, and which
// pages each area opens. Same keys as backend/src/security/teamAccess.js
// (the server checks every request; this only shapes the menu).

export const AREAS = [
  { key: 'whatsapp', label: 'WhatsApp', note: 'Dashboard, Inbox, Campaigns, Contacts, Templates, Knowledge base, Analytics, connection status' },
  { key: 'documents', label: 'Documents', note: 'BOQ & quotations, Image extractor' },
  { key: 'proforma', label: 'Proforma', note: 'Proforma invoice maker' },
  { key: 'ask_ai', label: 'Ask AI', note: 'Ask AI' },
  { key: 'vendor_kyc', label: 'Vendor KYC forms', note: 'Submitted vendor KYC forms and documents (sensitive)' },
  { key: 'technicians', label: 'Technician registrations', note: 'Technician forms, staff & targets, employees' },
  { key: 'storage', label: 'Storage', note: 'Storage monitoring and clean-up' },
  { key: 'settings', label: 'Settings', note: 'Change the app settings' },
]

export const AREA_LABELS = Object.fromEntries(AREAS.map((area) => [area.key, area.label]))

// Page → the areas that open it (any one is enough). 'Team & access' is
// for super admins only and is handled separately.
export const VIEW_AREAS = {
  Dashboard: ['whatsapp'],
  'WhatsApp Connection': ['whatsapp'],
  Inbox: ['whatsapp'],
  Campaigns: ['whatsapp'],
  Contacts: ['whatsapp'],
  Templates: ['whatsapp'],
  'Knowledge Base': ['whatsapp'],
  Analytics: ['whatsapp'],
  'Document Intelligence': ['documents'],
  'Image Extractor': ['documents'],
  'Submitted Forms': ['vendor_kyc', 'technicians'],
  'Proforma Maker': ['proforma'],
  'Ask AI': ['ask_ai'],
  Storage: ['storage'],
  Settings: ['settings'],
}

/** May an account with `access` (from GET /api/team/me) open `view`? */
export function canOpenView(access, view) {
  if (!access) return false
  if (view === 'Team & access') return Boolean(access.super_admin)
  const areas = VIEW_AREAS[view]
  return Boolean(areas && areas.some((area) => access.permissions?.includes(area)))
}
