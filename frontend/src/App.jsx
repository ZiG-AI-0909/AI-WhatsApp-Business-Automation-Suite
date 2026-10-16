import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import LandingPage from './LandingPage.jsx'
import OnboardingChecklist from './OnboardingChecklist.jsx'
import WelcomeAuthPage from './WelcomeAuthPage.jsx'
import ImageExtractorView from './ImageExtractorView.jsx'
import AskAiView from './AskAiView.jsx'
import DocumentIntelView from './DocumentIntelView.jsx'
import CopilotPanel from './CopilotPanel.jsx'
import { supabase, isSupabaseConfigured } from './supabaseClient.js'

// API helpers (apiFetch, socketAuth, session-invalidation event) now live in
// ./api.js — shared with the public landing page and onboarding checklist.
import { BACKEND_URL, apiFetch, socketAuth, dispatchSessionInvalidated, SESSION_INVALIDATED_EVENT, DATA_OWNER_HEADER, WORKSPACE_CHANGED_EVENT, hasStoredDataOwnerChoice, setStoredDataOwner } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'
import BrandLogo from './components/BrandLogo.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import ThemeChoice from './components/ThemeChoice.jsx'
import Modal from './components/Modal.jsx'
import SkeletonPanel from './components/Skeleton.jsx'
import { COUNTRIES } from './countries.js'

// Socket auth moved to ./api.js (socketAuth).

// Sidebar navigation. The item keys are the view names used by renderView();
// NAV_META only adds the icon and a friendlier label for the menu.
const NAV_GROUPS = [
  { title: 'Overview', items: ['Dashboard', 'Analytics'] },
  { title: 'Messaging', items: ['Inbox', 'Campaigns', 'Contacts', 'Templates'] },
  { title: 'Documents', items: ['Document Intelligence', 'Image Extractor'] },
  { title: 'AI assistant', items: ['Ask AI', 'Knowledge Base'] },
  { title: 'Setup', items: ['WhatsApp Connection', 'Settings'] },
]
const NAV_META = {
  Dashboard: { icon: 'dashboard' },
  Analytics: { icon: 'chart' },
  Inbox: { icon: 'chat' },
  Campaigns: { icon: 'megaphone' },
  Contacts: { icon: 'users' },
  Templates: { icon: 'file' },
  'Document Intelligence': { icon: 'clipboard', label: 'BOQ & quotations' },
  'Image Extractor': { icon: 'image', label: 'Image extractor' },
  'Ask AI': { icon: 'sparkles' },
  'Knowledge Base': { icon: 'book', label: 'Knowledge base' },
  'WhatsApp Connection': { icon: 'phone', label: 'WhatsApp connection' },
  Settings: { icon: 'sliders' },
}
const navLabel = (view) => NAV_META[view]?.label || view
const navGroupOf = (view) => NAV_GROUPS.find((group) => group.items.includes(view))?.title || ''
const CURRENT_YEAR = new Date().getFullYear()
const SIDEBAR_STORAGE_KEY = 'sp-sidebar'
const BUILDER_STEPS = [
  { id: 'audience', title: 'Audience', hint: 'Name and contacts' },
  { id: 'message', title: 'Message', hint: 'Text, fields, media' },
  { id: 'safety', title: 'Safety', hint: 'Timing and limits' },
  { id: 'review', title: 'Review', hint: 'Check and send' },
]

// Scroll to a section and move keyboard focus to it, honouring reduced motion.
function scrollToSection(id) {
  const target = document.getElementById(id)
  if (!target) return
  let reduce = false
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { reduce = false }
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  target.focus({ preventScroll: true })
}

function greetingNow() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

// Plain-language WhatsApp connection state for the status chip.
function connectionState(status) {
  const value = String(status || '').toLowerCase()
  if (value === 'connected') return { tone: 'ok', label: 'Connected' }
  if (value === 'business_connected') return { tone: 'ok', label: 'Connected (Business API)' }
  if (value === 'waiting_qr') return { tone: 'warn', label: 'Scan the QR code' }
  if (['initializing', 'reconnecting', 'connecting'].includes(value)) return { tone: 'warn', label: 'Connecting…' }
  if (value.startsWith('checking')) return { tone: 'neutral', label: 'Checking…' }
  if (value === 'offline') return { tone: 'bad', label: 'Server unreachable' }
  if (['disconnected', 'logged_out'].includes(value)) return { tone: 'bad', label: 'Reconnect needed' }
  return { tone: 'neutral', label: value ? value.replaceAll('_', ' ') : 'Unknown' }
}

function ConnectionChip({ status, block = false, onClick }) {
  const state = connectionState(status)
  const className = `conn-chip conn-${state.tone}${block ? ' block' : ''}`
  const content = <><span className="conn-dot" aria-hidden="true" /><span className="chip-text">WhatsApp: {state.label}</span></>
  if (onClick) {
    return <button type="button" className={className} onClick={onClick} title={`WhatsApp: ${state.label}. Open the connection page.`}>{content}</button>
  }
  return <span className={className} role="status" title={`WhatsApp: ${state.label}`}>{content}</span>
}

// Small SVG progress ring for KPI tiles (value 0–100).
function ProgressRing({ value, label }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <svg className="kpi-ring" viewBox="0 0 36 36" role="img" aria-label={label}>
      <circle className="kpi-ring-track" cx="18" cy="18" r="15.5" pathLength="100" />
      <circle className="kpi-ring-value" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${pct} 100`} />
    </svg>
  )
}

const percentOf = (part, whole) => (Number(whole) > 0 ? Math.round((Number(part) / Number(whole)) * 100) : null)

const mockLeads = [
  { id: 1, name: 'Ramesh Patel', company: 'Patel Hardware', phone: '+91 98765 42108', priority: 'hot', score: 87, source: 'verified', reason: 'Replied at 9:12 AM and asked for your price quote for 500 pipes.', action: 'Send quote', draft: 'Hi Ramesh, thanks for your interest. I have prepared the price quote for 500 pipes. Would you like it here on WhatsApp?' },
  { id: 2, name: 'Saanvi Traders', company: 'Saanvi Traders', phone: '+91 98220 11876', priority: 'warm', score: 62, source: 'review', reason: 'Contact details were read from a business card scan and have not been checked yet.', action: 'Send follow-up', draft: 'Hello Saanvi Traders, checking in on your pipe requirement. Is there a quantity or delivery date I can help with?' },
  { id: 3, name: 'Mehta Enterprises', company: 'Mehta Enterprises', phone: '+91 99110 04722', priority: 'cold', score: 31, source: null, reason: 'You sent product details five days ago and have not received a reply.', action: 'Send follow-up', draft: 'Hello, just checking whether you had a chance to review the product details I sent. I am happy to answer any questions.' },
]

function SourceMarker({ source }) {
  if (!source) return null
  return <span className={`source-marker ${source}`}>{source === 'verified' ? '✓ Verified scan' : '◌ Review scanned contact'}</span>
}

function LeadPriorityDashboard() {
  const [filter, setFilter] = useState('all')
  const [composer, setComposer] = useState(null)
  const [message, setMessage] = useState('')
  const leads = filter === 'all' ? mockLeads : mockLeads.filter((lead) => lead.priority === filter)
  const openComposer = (lead) => { setComposer(lead); setMessage(lead.draft) }
  return <div className="lead-dashboard">
    <section className="lead-dashboard-heading"><div><p className="eyebrow">Your workday</p><h2>Start with the people who need you today</h2><p className="muted-copy">Follow up at the right time and focus on the leads most likely to move forward.</p></div><button className="primary-btn">Add a lead</button></section>
    <section className="follow-up-panel"><div className="panel-header"><div><p className="eyebrow">Today’s follow-ups</p><h2>2 need your attention</h2><p className="muted-copy">Clear the urgent replies first so promising conversations do not go cold.</p></div><button className="secondary-btn">See all follow-ups</button></div><div className="follow-up-list"><article><span className="due-label overdue">Overdue</span><div><strong>Ramesh Patel needs the price quote he requested.</strong><small>Due yesterday · Last reply: “Please share the price for 500 pipes.”</small></div><button className="secondary-btn" onClick={() => openComposer(mockLeads[0])}>Prepare quote</button></article><article><span className="due-label today">Due today</span><div><strong>Check in with Saanvi Traders before 4:00 PM.</strong><small>They shared their business card at yesterday’s meeting.</small></div><button className="secondary-btn" onClick={() => openComposer(mockLeads[1])}>Prepare follow-up</button></article></div></section>
    <section className="lead-queue"><div className="panel-header"><div><p className="eyebrow">Your lead queue</p><h2>Who should you speak to next?</h2><p className="muted-copy">Each reason is based on a real activity, so you know why this is the right next step.</p></div></div><div className="lead-filters">{[['all', 'All leads'], ['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold']].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="lead-list">{leads.map((lead) => <article className="lead-card" key={lead.id}><div className="lead-card-main"><div className="lead-card-title"><span className={`priority-badge ${lead.priority}`}>{lead.priority === 'hot' ? 'Hot lead — likely ready to buy' : lead.priority === 'warm' ? 'Warm lead — keep the conversation going' : 'Cold lead — needs a gentle reminder'}</span><span className="score-detail">Score {lead.score}/100</span></div><div className="lead-identity"><div><h3>{lead.name}</h3><p>{lead.company} · {lead.phone}</p></div><SourceMarker source={lead.source} /></div><p className="lead-reason"><strong>Why now:</strong> {lead.reason}</p></div><button className="primary-btn" onClick={() => openComposer(lead)}>{lead.action}</button></article>)}</div></section>
    {composer && <div className="compose-backdrop" role="dialog" aria-modal="true"><section className="compose-panel"><div className="panel-header"><div><p className="eyebrow">Review before sending</p><h2>Message {composer.name}</h2><p className="muted-copy">Nothing is sent until you review and choose Send.</p></div><button className="secondary-btn" onClick={() => setComposer(null)}>Close</button></div><label className="form-label">Your message<textarea value={message} onChange={(event) => setMessage(event.target.value)} /><small>Make this sound like you before sending. AI suggestions will always be clearly marked and editable.</small></label><div className="button-row"><button className="primary-btn" onClick={() => setComposer(null)}>Send after review</button><button className="secondary-btn" onClick={() => setComposer(null)}>Save for later</button></div></section></div>}
  </div>
}

const mockConversations = [
  { id: 1, lead: mockLeads[0], unread: 2, needsReply: true, message: 'Please share the price for 500 pipes.', time: '9:12 AM' },
  { id: 2, lead: mockLeads[1], unread: 0, needsReply: true, message: 'Thanks, I will check the quantities today.', time: 'Yesterday' },
  { id: 3, lead: mockLeads[2], unread: 0, needsReply: false, message: 'Product details sent. Follow-up is due in 2 days.', time: 'Mon' },
]

function MockInbox() {
  const [selectedId, setSelectedId] = useState(1)
  const [draft, setDraft] = useState('')
  const selected = mockConversations.find((item) => item.id === selectedId)
  const showSuggestion = () => setDraft(`Hi ${selected.lead.name.split(' ')[0]}, thank you for your message. I can share the details you asked for right here. Would you like the quote including delivery?`)
  return <div className="mock-inbox"><section className="lead-dashboard-heading"><div><p className="eyebrow">WhatsApp inbox</p><h2>Reply to the conversations that need you</h2><p className="muted-copy">Unread messages and conversations waiting for a reply are shown first.</p></div></section><div className="mock-inbox-layout"><aside className="mock-conversation-list"><div className="panel-header"><h2>Needs a reply</h2><span className="reply-count">2 waiting</span></div>{mockConversations.map((item) => <button className={`mock-conversation ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setDraft('') }} key={item.id}><div><strong>{item.lead.name}</strong><SourceMarker source={item.lead.source} /></div><p>{item.message}</p><small>{item.needsReply ? 'Reply needed' : 'Handled'} · {item.time}</small>{item.unread > 0 && <span className="unread-marker">{item.unread} new messages</span>}</button>)}</aside><section className="mock-chat"><header><div><p className="eyebrow">Conversation</p><h2>{selected.lead.name}</h2><p>{selected.lead.company} · {selected.lead.phone} <SourceMarker source={selected.lead.source} /></p></div><span className={selected.needsReply ? 'reply-status needed' : 'reply-status handled'}>{selected.needsReply ? 'Reply needed' : 'Handled'}</span></header><div className="mock-message-stream"><article className="mock-message incoming"><small>{selected.lead.name} · {selected.time}</small><p>{selected.message}</p></article><article className="mock-message outgoing"><small>You · Yesterday</small><p>Hello! Thanks for getting in touch. I can help with the right pipe and delivery option.</p></article></div><div className="ai-suggestion"><div><strong>AI suggestion — edit before sending</strong><p>This is a draft only. Check the details and change the wording before you send it.</p></div><button className="secondary-btn" onClick={showSuggestion}>Use as a starting point</button></div><div className="mock-composer"><label className="form-label">Your reply<textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a reply, or start with the AI suggestion…" /><small>Nothing sends automatically. Review your message before choosing Send.</small></label><button className="primary-btn">Send after review</button></div></section></div></div>
}

const defaultTemplate = `Hello {{name}} 👋\n\nThis is Sudarshan Pipes.\nWe wanted to know if {{company}} currently has any requirements for {{product}} in {{city}}.\n\nPlease let us know your required quantity.`

// Why a campaign paused (mirrors backend/src/campaigns/sendPolicy.js).
const PAUSE_REASON_TEXT = {
  whatsapp_disconnected: 'WhatsApp is disconnected. Reconnect to continue; nothing is lost.',
  provider_restriction: 'WhatsApp reported a sending restriction. Wait before resuming and review recent failures.',
  rate_limited: 'WhatsApp asked us to slow down (rate limit). The campaign can resume after the cooldown.',
  account_restricted: 'WhatsApp restricted this number (spam or policy limit). Do not resume until the restriction is lifted in WhatsApp Manager.',
  quality_low: 'WhatsApp lowered or flagged this number’s quality rating. Review message content and recipient consent before resuming.',
  provider_auth_failed: 'The WhatsApp Business API rejected the credentials. Update the access token in Settings, then resume.',
  provider_account_issue: 'The WhatsApp Business account needs attention (payment, registration or certificate). Fix it in WhatsApp Manager, then resume.',
  template_required: 'These recipients have not messaged you in the last 24 hours, so WhatsApp only allows an approved message template. Add an approved template to the campaign, then resume.',
  template_error: 'WhatsApp rejected the message template (missing, paused, disabled or wrong variables). Fix the template settings, then resume.',
  high_failure_rate: 'Too many recent messages failed. The campaign was paused to protect your number; review the errors before resuming.',
  many_unregistered_numbers: 'Many recent numbers are not on WhatsApp. Messaging unknown numbers is a spam signal; clean the list before resuming.',
  repeated_send_failures: 'The same error repeated several times in a row. Review it before resuming.',
  media_upload_failed: 'The attachment could not be sent. Check the file, then resume.',
  media_load_failed: 'The campaign attachment could not be loaded. Replace it or resume to retry.',
  campaign_start_failed: 'The queued campaign could not start.',
}
const pauseReasonText = (reason) => PAUSE_REASON_TEXT[reason] || String(reason || '').replaceAll('_', ' ')

// Why a running campaign is not sending right now.
const WAITING_TEXT = {
  hourly_limit: 'your hourly sending limit is reached',
  daily_limit: 'your daily sending limit is reached',
  provider_daily_limit: 'WhatsApp’s daily messaging limit for this number is reached',
  outside_business_hours: 'outside your business hours',
  cooldown: 'pausing between batches',
  scheduled_retries: 'retries and recipients outside their local business hours are scheduled',
}

// One recipient's result, including WhatsApp delivery receipts when known.
const RECIPIENT_STATUS_TEXT = { pending: 'Queued', processing: 'Sending', sent: 'Sent', failed: 'Failed', opted_out: 'Opted out', skipped: 'Skipped' }
function recipientStatusLabel(contact) {
  if (contact.status === 'sent' && contact.delivery_status === 'read') return 'Read'
  if (contact.status === 'sent' && contact.delivery_status === 'delivered') return 'Delivered'
  return RECIPIENT_STATUS_TEXT[contact.status] || String(contact.status || '').replaceAll('_', ' ')
}

const OPT_OUT_SOURCE_TEXT = { reply: 'replied STOP', manual: 'marked opted out', whatsapp: 'WhatsApp marketing opt-out' }
function consentTitle(contact) {
  if (contact.marketing_opt_in) {
    return contact.opted_in_at ? `Opted in ${new Date(contact.opted_in_at).toLocaleDateString()}${contact.opt_in_source ? ` (${contact.opt_in_source})` : ''}` : undefined
  }
  if (contact.opted_out_at) return `Opted out ${new Date(contact.opted_out_at).toLocaleDateString()} (${OPT_OUT_SOURCE_TEXT[contact.opt_out_source] || contact.opt_out_source || 'unknown'})`
  return 'No marketing consent recorded'
}

// Turning marketing back on for someone who asked to stop needs an explicit
// confirmation; the server refuses it otherwise (409 OPTED_OUT).
async function saveWithConsentCheck(request) {
  try {
    return await request({})
  } catch (error) {
    if (error?.code !== 'OPTED_OUT' || !window.confirm(`${error.message}\n\nDid this contact ask to receive marketing messages again?`)) throw error
    return request({ confirm_resubscribe: true })
  }
}

function CampaignsView({ onNavigate }) {
  const [campaignList, setCampaignList] = useState([])
  const [campaignEstimate, setCampaignEstimate] = useState(null)
  const [queueEstimates, setQueueEstimates] = useState({})
  const [schedules, setSchedules] = useState([])
  const [scheduleEstimates, setScheduleEstimates] = useState({})
  const [selectedScheduleIds, setSelectedScheduleIds] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [selectedCampaign, setSelectedCampaign] = useState(null)
  const [duplicateDialog, setDuplicateDialog] = useState(null)
  const [duplicateName, setDuplicateName] = useState('')
  const [duplicateContacts, setDuplicateContacts] = useState('all')
  const [draftEdit, setDraftEdit] = useState(null)
  const [draftEditCampaignId, setDraftEditCampaignId] = useState(null)
  const [draftExcelPath, setDraftExcelPath] = useState('')
  const editCampaignDraft = (campaign, event) => {
    event?.stopPropagation()
    const parse = (value, fallback) => {
      if (typeof value !== 'string') return value || fallback
      try { return JSON.parse(value) } catch { return fallback }
    }
    setSelectedCampaign(campaign)
    setDraftEditCampaignId(campaign.id)
    setDraftEdit({
      name: campaign.name,
      template_message: campaign.template_message || '',
      settings: parse(campaign.settings, {}),
      buttons: parse(campaign.buttons, []),
      media_path: campaign.media_path || '',
      media_bucket: campaign.media_bucket || '',
      media_object_path: campaign.media_object_path || '',
      media_type: campaign.media_type || '',
      media_filename: campaign.media_filename || '',
      media_mimetype: campaign.media_mimetype || '',
    })
    setDraftExcelPath('')
  }
  const [draftRecipientsMode, setDraftRecipientsMode] = useState('replace')
  const [excludeMessaged, setExcludeMessaged] = useState(false)
  const [excludeCampaignIds, setExcludeCampaignIds] = useState([])
  const [file, setFile] = useState(null)
  const [mediaFile, setMediaFile] = useState(null)
  const [mediaPath, setMediaPath] = useState('')
  const [mediaBucket, setMediaBucket] = useState('')
  const [mediaObjectPath, setMediaObjectPath] = useState('')
  const [mediaType, setMediaType] = useState('')
  const [mediaFilename, setMediaFilename] = useState('')
  const [mediaMimetype, setMediaMimetype] = useState('')
  const [mediaPreview, setMediaPreview] = useState('')
  const [buttons, setButtons] = useState([])
  const [upload, setUpload] = useState(null)
  // Per-upload country override: defaults to the account's Settings choice,
  // changeable per file. null until settings load; sent with every upload.
  const [uploadCountryCode, setUploadCountryCode] = useState('')
  const [accountCountries, setAccountCountries] = useState(COUNTRIES)
  const [template, setTemplate] = useState(defaultTemplate)
  const [name, setName] = useState('')
  const [circuitBreakerThreshold, setCircuitBreakerThreshold] = useState('5')
  const [queueStatus, setQueueStatus] = useState(null)
  // When the list was last loaded (every 30 s and after each action); used to
  // hold Resume until a rate-limit cooldown has passed.
  const [listLoadedAt, setListLoadedAt] = useState(() => Date.now())
  const [respectRecipientHours, setRespectRecipientHours] = useState(true)
  const [failureRatePause, setFailureRatePause] = useState('0.5')
  const [cooldownEvery, setCooldownEvery] = useState('0')
  const [cooldownMinutes, setCooldownMinutes] = useState('10')
  const [waTemplateName, setWaTemplateName] = useState('')
  const [waTemplateLanguage, setWaTemplateLanguage] = useState('en')
  const [waTemplateParams, setWaTemplateParams] = useState('')
  const [scheduleType, setScheduleType] = useState('now')
  const [runAt, setRunAt] = useState('')
  const [recurrenceMode, setRecurrenceMode] = useState('daily')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [scheduleWeekday, setScheduleWeekday] = useState('1')
  const [scheduleMonthDay, setScheduleMonthDay] = useState('1')
  const [customCron, setCustomCron] = useState('')
  const [previews, setPreviews] = useState([])
  const [missingByField, setMissingByField] = useState({})
  const [campaignContacts, setCampaignContacts] = useState([])
  const [whatsappStatus, setWhatsappStatus] = useState({ provider: '', status: 'checking' })
  const [allowMissingFields, setAllowMissingFields] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)

  const openDuplicateDialog = (campaign, event) => {
    event?.stopPropagation()
    setDuplicateDialog(campaign)
    setDuplicateName(`${campaign.name} (copy)`)
    setDuplicateContacts('all')
  }

  const duplicateCampaign = async () => {
    if (!duplicateDialog) return
    setBusy(true)
    try {
      const result = await apiFetch(`/campaigns/${duplicateDialog.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: duplicateName, contacts: duplicateContacts, excludeMessaged, excludeCampaignIds }),
      })
      setSelectedCampaign(result.campaign)
      setDraftEditCampaignId(result.campaign.id)
      setDraftEdit({
        name: result.campaign.name,
        template_message: result.campaign.template_message || '',
        settings: typeof result.campaign.settings === 'string' ? JSON.parse(result.campaign.settings || '{}') : (result.campaign.settings || {}),
        buttons: typeof result.campaign.buttons === 'string' ? JSON.parse(result.campaign.buttons || '[]') : (result.campaign.buttons || []),
        media_path: result.campaign.media_path || '',
        media_bucket: result.campaign.media_bucket || '',
        media_object_path: result.campaign.media_object_path || '',
        media_type: result.campaign.media_type || '',
        media_filename: result.campaign.media_filename || '',
        media_mimetype: result.campaign.media_mimetype || '',
      })
      setDraftExcelPath('')
      setDraftRecipientsMode('replace')
      setDuplicateDialog(null)
      setMessage({ type: 'success', text: `Draft created. ${result.skippedOptedOut} opted-out contacts skipped${result.excludedMessaged ? `; ${result.excludedMessaged} previously messaged contacts excluded` : ''}.` })
      await loadCampaigns()
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Duplicate campaign' }) })
    } finally {
      setBusy(false)
    }
  }

  const saveCampaignDraft = async (action = 'save') => {
    if (!selectedCampaign || !draftEdit) return
    setBusy(true)
    try {
      const updated = await apiFetch(`/campaigns/${selectedCampaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draftEdit, filePath: draftExcelPath || undefined, recipientsMode: draftRecipientsMode, excludeMessaged, excludeCampaignIds }),
      })
      setSelectedCampaign(updated)
      setDraftEdit({
        ...draftEdit,
        settings: typeof updated.settings === 'string' ? JSON.parse(updated.settings || '{}') : updated.settings,
        buttons: typeof updated.buttons === 'string' ? JSON.parse(updated.buttons || '[]') : updated.buttons,
      })
      setDraftExcelPath('')
      setDraftRecipientsMode('replace')
      await loadCampaigns()
      if (action === 'start') {
        await apiFetch(`/campaigns/${updated.id}/start`, { method: 'POST' })
        setDraftEdit(null)
      } else if (action === 'queue') {
        await apiFetch(`/campaigns/${updated.id}/queue`, { method: 'POST' })
        setDraftEdit(null)
      }
      await loadCampaigns()
      const excludedNote = Number(updated.excluded_messaged_count) > 0 ? ` ${updated.excluded_messaged_count} previously messaged contacts excluded.` : ''
      setMessage({ type: 'success', text: (action === 'start' ? 'Draft saved and started.' : action === 'queue' ? 'Draft saved and added to the queue.' : 'Draft saved.') + excludedNote })
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaign draft' }) })
    } finally {
      setBusy(false)
    }
  }

  const uploadDraftExcel = async (event) => {
    const excelFile = event.target.files?.[0]
    if (!excelFile) return
    const formData = new FormData()
    formData.append('file', excelFile)
    formData.append('countryCode', uploadCountryCode || '91')
    setBusy(true)
    try {
      const result = await apiFetch('/campaigns/validate-excel', { method: 'POST', body: formData })
      setDraftExcelPath(result.filePath)
      setMessage({ type: 'success', text: `${result.valid} valid recipients ready to replace the draft list.` })
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaign recipients' }) })
    } finally {
      setBusy(false)
    }
  }

  const uploadDraftMedia = async (event) => {
    const media = event.target.files?.[0]
    if (!media || !draftEdit) return
    const formData = new FormData()
    formData.append('file', media)
    setBusy(true)
    try {
      const result = await apiFetch('/campaigns/media', { method: 'POST', body: formData })
      setDraftEdit(current => ({ ...current, media_path: result.mediaPath, media_bucket: result.mediaBucket, media_object_path: result.mediaObjectPath, media_type: result.mediaType, media_filename: result.filename, media_mimetype: result.mimetype }))
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaign media' }) })
    } finally {
      setBusy(false)
    }
  }

  const loadCampaigns = async () => {
    setListLoadedAt(Date.now())
    try {
      const data = await apiFetch('/campaigns?limit=1000')
      const campaigns = data.data || []
      setCampaignList(campaigns)
      setQueueEstimates(await apiFetch('/campaigns/queue-estimates'))
      apiFetch('/campaigns/queue-status').then(setQueueStatus).catch(() => {})
      if (selectedCampaign) {
        const current = (data.data || []).find((item) => item.id === selectedCampaign.id)
        if (current) setSelectedCampaign(current)
      }
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    }
  }

  const loadSchedules = async () => {
    try {
      const list = await apiFetch('/schedules')
      setSchedules(list)
      // Time calculator: the list response now carries one shared `estimate`
      // per runnable schedule (computed server-side in a single pass). Only
      // fall back to the batched estimates endpoint when a row lacks it.
      let estimates = {}
      const withEstimate = (list || []).filter((schedule) => schedule.estimate)
      for (const schedule of withEstimate) estimates[schedule.id] = schedule.estimate
      const missing = (list || []).filter((schedule) => ['pending', 'active'].includes(schedule.status) && !schedule.estimate)
      if (missing.length) {
        const batch = await apiFetch('/schedules/estimates').catch(() => [])
        for (const estimate of (batch || [])) estimates[estimate.scheduleId] = estimate
      }
      setScheduleEstimates(estimates)
    } catch (error) { setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) }) }
  }

  useEffect(() => {
    loadCampaigns()
    // 30s safety-net polling interval; socket events drive real-time updates
    const interval = window.setInterval(loadCampaigns, 30000)
    return () => window.clearInterval(interval)
  }, [selectedCampaign?.id])

  useEffect(() => {
    loadSchedules()
    const interval = window.setInterval(loadSchedules, 30000)
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'], auth: socketAuth() })
    // DEBUG: connection lifecycle — connect_error means the server rejected
    // the handshake (usually auth), which also means no room join happened.
    socket.on('connect', () => console.log('[socket:Campaigns] connected — id', socket.id))
    socket.on('connect_error', (error) => console.error('[socket:Campaigns] connect_error:', error.message))
    socket.on('disconnect', (reason) => console.warn('[socket:Campaigns] disconnected:', reason))

    // Handle schedule:failed events
    const scheduleFailed = (event) => { setMessage({ type: 'error', text: `Schedule "${event.name}" failed: ${event.error}` }); loadSchedules() }
    socket.on('schedule:failed', scheduleFailed)

    // Handle schedule:waiting_connection — a due schedule whose owner's
    // WhatsApp session is down (auto-reconnect was attempted and failed).
    // Surface it so the wait isn't silent; the schedules table also shows
    // the same reason via schedule.last_error.
    const scheduleWaiting = (event) => {
      setMessage({ type: 'warning', text: `Scheduled campaign "${event.name || ''}" is waiting: ${event.error || 'WhatsApp is not connected.'}` })
      loadSchedules()
    }
    socket.on('schedule:waiting_connection', scheduleWaiting)

    // Handle campaign:progress events — update state directly for instant UI response
    const campaignProgress = (campaign) => {
      setCampaignList((current) => {
        const idx = current.findIndex((c) => c.id === campaign.id)
        if (idx === -1) return current
        const updated = [...current]
        updated[idx] = campaign
        return updated
      })
      // Update selectedCampaign if it matches (use setState callback to avoid stale closure)
      setSelectedCampaign((current) => current?.id === campaign.id ? campaign : current)
      // campaignContacts will auto-refetch via dependency on selectedCampaign?.processed
    }
    socket.on('campaign:progress', campaignProgress)

    // Handle status change events — full refresh for correctness
    const campaignStatusChange = async () => {
      await loadCampaigns()
    }
    socket.on('campaign:started', campaignStatusChange)
    socket.on('campaign:paused', campaignStatusChange)
    socket.on('campaign:resumed', campaignStatusChange)
    socket.on('campaign:stopped', campaignStatusChange)
    socket.on('campaign:completed', campaignStatusChange)
    socket.on('campaign:error', campaignStatusChange)
    // Why the running campaign is on hold (limits, hours, cooldown, retries)
    // and quality warnings from WhatsApp.
    const campaignWaiting = (event) => setQueueStatus((current) => ({ ...(current || {}), currentCampaignId: event.campaignId, waiting: event.waiting || null }))
    const campaignWarning = (event) => {
      setQueueStatus((current) => ({ ...(current || {}), warning: event.message }))
      setMessage({ type: 'warning', text: event.message })
    }
    socket.on('campaign:waiting', campaignWaiting)
    socket.on('campaign:warning', campaignWarning)

    return () => {
      socket.off('schedule:failed', scheduleFailed)
      socket.off('schedule:waiting_connection', scheduleWaiting)
      socket.off('campaign:progress', campaignProgress)
      socket.off('campaign:started', campaignStatusChange)
      socket.off('campaign:paused', campaignStatusChange)
      socket.off('campaign:resumed', campaignStatusChange)
      socket.off('campaign:stopped', campaignStatusChange)
      socket.off('campaign:completed', campaignStatusChange)
      socket.off('campaign:error', campaignStatusChange)
      socket.off('campaign:waiting', campaignWaiting)
      socket.off('campaign:warning', campaignWarning)
      socket.disconnect()
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const loadWhatsappStatus = async () => {
      try {
        setWhatsappStatus(await apiFetch('/whatsapp/status'))
      } catch {
        setWhatsappStatus({ provider: '', status: 'unavailable' })
      }
    }
    loadWhatsappStatus()
    const interval = window.setInterval(loadWhatsappStatus, 4000)
    return () => window.clearInterval(interval)
  }, [])

  // Load the account's default country code (Settings → Default country code)
  // once, to pre-select the per-upload selector.
  useEffect(() => {
    apiFetch('/settings')
      .then((settings) => {
        setUploadCountryCode(settings.defaultCountryCode || '91')
        if (Array.isArray(settings.countries) && settings.countries.length) setAccountCountries(settings.countries)
      })
      .catch(() => setUploadCountryCode((current) => current || '91'))
  }, [])

  useEffect(() => {
    if (!selectedCampaign) { setCampaignContacts([]); return }
    apiFetch(`/campaigns/${selectedCampaign.id}/contacts?limit=100`).then((data) => setCampaignContacts(data.data || [])).catch(() => setCampaignContacts([]))
  }, [selectedCampaign?.id, selectedCampaign?.processed])

  useEffect(() => {
    if (!selectedCampaign) { setCampaignEstimate(null); return }
    setCampaignEstimate(null)
    apiFetch(`/campaigns/${selectedCampaign.id}/estimate`)
      .then(setCampaignEstimate)
      .catch((error) => setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaign estimate' }) }))
  }, [selectedCampaign?.id, selectedCampaign?.processed, selectedCampaign?.status])

  const uploadExcel = async (event) => {
    const nextFile = event.target.files?.[0]
    if (!nextFile) return
    setFile(nextFile)
    setUpload(null)
    setPreviews([])
    setMissingByField({})
    setMessage({ type: '', text: '' })
    await validateWithCountry(nextFile, uploadCountryCode)
  }

  // Re-validate the already-uploaded file against a (new) country code.
  // The backend re-uploads + re-parses, so changing the selector re-formats
  // every phone number without requiring the user to re-pick the file.
  const validateWithCountry = async (targetFile, countryCode) => {
    if (!targetFile) return
    const formData = new FormData()
    formData.append('file', targetFile)
    if (countryCode) formData.append('countryCode', countryCode)
    setBusy(true)
    try {
      const data = await apiFetch('/campaigns/validate-excel', { method: 'POST', body: formData })
      setUpload(data)
      setMessage({ type: 'success', text: data.formattingNotice || `${data.valid} valid contacts ready.` })
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    } finally {
      setBusy(false)
    }
  }

  const downloadRejectedRows = () => {
    if (!upload?.rejectedCsv || !upload.rejectedRowCount) return
    const blob = new Blob([upload.rejectedCsv], { type: 'text/csv;charset=utf-8' })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = upload.rejectedCsvFilename || 'campaign-rejected-rows.csv'
    link.click()
    window.URL.revokeObjectURL(url)
  }

  const changeUploadCountry = (event) => {
    setUploadCountryCode(event.target.value)
    // Only re-validate when a file is already loaded; otherwise the choice
    // is simply remembered for the next upload.
    if (file) validateWithCountry(file, event.target.value)
  }

  const uploadMedia = async (event) => {
    const nextFile = event.target.files?.[0]
    if (!nextFile) return
    setMediaFile(nextFile)
    setMediaPreview(URL.createObjectURL(nextFile))
    setMediaPath('')
    setMediaBucket('')
    setMediaObjectPath('')
    setMediaType('')
    setMediaFilename('')
    setMediaMimetype('')
    setMessage({ type: '', text: '' })
    const formData = new FormData()
    formData.append('file', nextFile)
    setBusy(true)
    try {
      const data = await apiFetch('/campaigns/media', { method: 'POST', body: formData })
      setMediaPath(data.mediaPath)
      setMediaBucket(data.mediaBucket)
      setMediaObjectPath(data.mediaObjectPath)
      setMediaType(data.mediaType)
      setMediaFilename(data.filename)
      setMediaMimetype(data.mimetype)
      const isImage = data.mediaType === 'image'
      setMessage({ type: 'success', text: `Campaign ${isImage ? 'image' : 'document'} uploaded.` })
    } catch (error) {
      setMediaFile(null)
      setMediaPreview('')
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    } finally {
      setBusy(false)
    }
  }

  const previewMessages = async () => {
    if (!upload?.filePath || !template.trim()) return
    setBusy(true)
    try {
      const data = await apiFetch('/campaigns/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: upload.filePath, template, count: 5 }),
      })
      setPreviews(data.previews || [])
      setMissingByField(data.missingByField || {})
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    } finally {
      setBusy(false)
    }
  }

  const createCampaign = async (event) => {
    event.preventDefault()
    if (!upload?.filePath) return setMessage({ type: 'error', text: 'Upload a valid XLSX file first.' })
    setBusy(true)
    try {
      const buttonsPayload = whatsappStatus.businessStatus === 'connected' ? buttons : []
      const settingsPayload = {
        delayBetweenMessages: 17500,
        retryCount: 2,
        retryDelay: 30000,
        circuitBreakerThreshold: Number(circuitBreakerThreshold),
        respectRecipientTimezone: respectRecipientHours,
        failureRatePauseThreshold: Number(failureRatePause),
        cooldownEvery: Number(cooldownEvery) || 0,
        cooldownMinutes: Number(cooldownMinutes) || 10,
        ...(whatsappStatus.businessStatus === 'connected' && waTemplateName.trim()
          ? { waTemplate: { name: waTemplateName.trim(), language: waTemplateLanguage.trim() || 'en', bodyParams: waTemplateParams.split('\n').map((line) => line.trim()).filter(Boolean) } }
          : {}),
        excludeMessaged,
        excludeCampaignIds,
      }
      if (['once', 'recurring'].includes(scheduleType)) {
        if (scheduleType === 'once' && (!runAt || new Date(runAt) <= new Date())) throw new Error('Choose a future date and time.')
        const recurrenceCron = scheduleType === 'recurring' ? (recurrenceMode === 'custom' ? customCron.trim() : (() => { const [hour, minute] = scheduleTime.split(':'); if (recurrenceMode === 'weekly') return `${minute} ${hour} * * ${scheduleWeekday}`; if (recurrenceMode === 'monthly') return `${minute} ${hour} ${scheduleMonthDay} * *`; return `${minute} ${hour} * * *` })()) : undefined
        await apiFetch('/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, templateMessage: template, filePath: upload.filePath, mediaPath: mediaPath || undefined, mediaBucket: mediaBucket || undefined, mediaObjectPath: mediaObjectPath || undefined, mediaType: mediaType || undefined, mediaFilename: mediaFilename || undefined, mediaMimetype: mediaMimetype || undefined, buttons: buttonsPayload, allowMissingFields, settings: settingsPayload, scheduleType, runAt: scheduleType === 'once' ? new Date(runAt).toISOString() : undefined, recurrenceCron, countryCode: uploadCountryCode || undefined }) })
        setMessage({ type: 'success', text: scheduleType === 'once' ? 'Campaign scheduled.' : 'Recurring campaign schedule created.' })
        await loadSchedules()
      } else {
        const campaign = await apiFetch('/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, templateMessage: template, filePath: upload.filePath, mediaPath: mediaPath || undefined, mediaBucket: mediaBucket || undefined, mediaObjectPath: mediaObjectPath || undefined, mediaType: mediaType || undefined, mediaFilename: mediaFilename || undefined, mediaMimetype: mediaMimetype || undefined, buttons: buttonsPayload, allowMissingFields, settings: settingsPayload, countryCode: uploadCountryCode || undefined, excludeMessaged, excludeCampaignIds }),
        })
        if (scheduleType === 'queue') {
          await apiFetch(`/campaigns/${campaign.id}/queue`, { method: 'POST' })
        } else {
          await apiFetch(`/campaigns/${campaign.id}/start`, { method: 'POST' })
        }
        setSelectedCampaign(campaign)
        const excludedNote = Number(campaign.excluded_messaged_count) > 0 ? ` ${campaign.excluded_messaged_count} previously messaged contacts excluded.` : ''
        setMessage({ type: 'success', text: (scheduleType === 'queue' ? `Campaign added to the queue with ${campaign.total_contacts} contacts.` : `Campaign started with ${campaign.total_contacts} contacts.`) + excludedNote })
        await loadCampaigns()
      }
      setName('')
      setFile(null)
      setUpload(null)
      setMediaFile(null)
      setMediaPath('')
      setMediaBucket('')
      setMediaObjectPath('')
      setMediaType('')
      setMediaFilename('')
      setMediaMimetype('')
      setMediaPreview('')
      setButtons([])
      setPreviews([])
      setMissingByField({})
      setScheduleType('now')
      setRunAt('')
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    } finally {
      setBusy(false)
    }
  }

  const controlCampaign = async (action) => {
    if (!selectedCampaign) return
    setBusy(true)
    try {
      await apiFetch(`/campaigns/${selectedCampaign.id}/${action}`, { method: 'POST' })
      await loadCampaigns()
      const refreshed = await apiFetch(`/campaigns/${selectedCampaign.id}`)
      setSelectedCampaign(refreshed)
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    } finally {
      setBusy(false)
    }
  }

  const testCampaignMedia = async () => {
    if (!selectedCampaign?.id) return
    setBusy(true)
    try {
      const result = await apiFetch(`/campaigns/${selectedCampaign.id}/test-media`, { method: 'POST' })
      setMessage({ type: 'success', text: result.message || 'Media test sent to your WhatsApp number.' })
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    } finally {
      setBusy(false)
    }
  }

  const retryFailedContacts = async () => {
    if (!selectedCampaign) return
    setBusy(true)
    try {
      const result = await apiFetch(`/campaigns/${selectedCampaign.id}/retry-failed`, { method: 'POST' })
      const refreshed = await apiFetch(`/campaigns/${selectedCampaign.id}`)
      setSelectedCampaign(refreshed)
      await loadCampaigns()
      setMessage({ type: 'success', text: `Retrying ${result.requeued} failed contact(s).` })
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) })
    } finally {
      setBusy(false)
    }
  }

  const toggleCampaign = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllCampaigns = () => setSelectedIds(selectedIds.length === campaignList.length ? [] : campaignList.map((campaign) => campaign.id))
  const bulkDelete = async () => {
    if (!selectedIds.length) return
    const runningCount = campaignList.filter((campaign) => selectedIds.includes(campaign.id) && campaign.status === 'running').length
    const warning = runningCount ? ` This will stop ${runningCount} running campaign(s) before deleting.` : ''
    if (!window.confirm(`Delete ${selectedIds.length} selected campaign(s)?${warning}`)) return
    setBusy(true)
    try { await apiFetch('/campaigns/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setSelectedCampaign(null); setMessage({ type: 'success', text: `${selectedIds.length} campaign(s) deleted.` }); await loadCampaigns() } catch (error) { setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) }) } finally { setBusy(false) }
  }

  const scheduleAction = async (id, action, method = 'PATCH') => {
    try { await apiFetch(`/schedules/${id}${action ? `/${action}` : ''}`, { method }); await loadSchedules() } catch (error) { setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) }) }
  }
  const retrySchedule = async (id) => { await scheduleAction(id, 'retry') }
  const deleteSchedule = async (id) => { if (!window.confirm('Delete this schedule?')) return; await scheduleAction(id, '', 'DELETE') }
  const toggleSchedule = (id) => setSelectedScheduleIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllSchedules = () => setSelectedScheduleIds(selectedScheduleIds.length === schedules.length ? [] : schedules.map((schedule) => schedule.id))
  const bulkDeleteSchedules = async () => { if (!selectedScheduleIds.length || !window.confirm(`Delete ${selectedScheduleIds.length} selected schedule(s)?`)) return; try { await apiFetch('/schedules/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedScheduleIds }) }); setSelectedScheduleIds([]); await loadSchedules() } catch (error) { setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaigns' }) }) } }

  const statusClass = (status) => `campaign-status ${status === 'completed_with_errors' ? 'completed-with-errors' : String(status || '').toLowerCase()}`
  const queuedCampaigns = campaignList.filter((campaign) => campaign.status === 'queued').sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0))
  const queueStartEstimate = (campaign) => {
    const targetIndex = queuedCampaigns.findIndex((item) => item.id === campaign.id)
    if (targetIndex < 0 || !queueEstimates[campaign.id]) return null
    const running = campaignList.find((item) => item.status === 'running')
    const runningEstimate = running ? queueEstimates[running.id] : null
    const firstQueuedStart = queueEstimates[queuedCampaigns[0]?.id]?.startAt
    const base = runningEstimate?.endAt ? new Date(runningEstimate.endAt) : firstQueuedStart ? new Date(firstQueuedStart) : new Date()
    const precedingDuration = queuedCampaigns.slice(0, targetIndex)
      .reduce((total, item) => total + (Number(queueEstimates[item.id]?.durationMs) || 0), 0)
    return new Date(base.getTime() + precedingDuration)
  }
  const moveQueuedCampaign = async (campaign, direction, event) => {
    event.stopPropagation()
    const index = queuedCampaigns.findIndex((item) => item.id === campaign.id)
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= queuedCampaigns.length) return
    const reordered = [...queuedCampaigns]
    ;[reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]]
    try {
      await apiFetch('/campaigns/queue/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: reordered.map((item) => item.id) }),
      })
      await loadCampaigns()
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaign queue' }) })
    }
  }
  const removeQueuedCampaign = async (campaign, event) => {
    event.stopPropagation()
    try {
      await apiFetch(`/campaigns/${campaign.id}/unqueue`, { method: 'POST' })
      await loadCampaigns()
    } catch (error) {
      setMessage({ type: 'error', text: friendlyErrorMessage(error, { context: 'Campaign queue' }) })
    }
  }
  // Delivery dashboard for the selected campaign.
  const resumeLocked = selectedCampaign?.status === 'paused' && !!selectedCampaign?.resume_after && new Date(selectedCampaign.resume_after).getTime() > listLoadedAt
  const selectedWaiting = selectedCampaign?.status === 'running' && queueStatus?.currentCampaignId === selectedCampaign?.id ? queueStatus.waiting : null
  const deliveryTracked = selectedCampaign?.delivered !== undefined && selectedCampaign?.delivered !== null
  const campaignTotal = Number(selectedCampaign?.total_contacts) || 0
  const campaignProcessed = Number(selectedCampaign?.processed) || 0
  const campaignPercent = campaignTotal ? Math.min(100, Math.round((campaignProcessed / campaignTotal) * 100)) : 0
  const campaignTiles = selectedCampaign ? [
    ['Recipients', campaignTotal, 'blue'],
    ['Queued', Math.max(0, campaignTotal - campaignProcessed), 'violet'],
    ['Sent', Number(selectedCampaign.sent) || 0, 'green'],
    ['Delivered', deliveryTracked ? Number(selectedCampaign.delivered) || 0 : '—', 'green'],
    ['Read', deliveryTracked ? Number(selectedCampaign.read_count) || 0 : '—', 'blue'],
    ['Failed', Number(selectedCampaign.failed) || 0, 'amber'],
    ['Opted out', Number(selectedCampaign.opt_outs) || 0, 'amber'],
    ['Skipped', Number(selectedCampaign.skipped) || 0, 'violet'],
  ] : []
  const selectedProviderConnected = selectedCampaign?.provider === 'business'
    ? whatsappStatus.businessStatus === 'connected'
    : whatsappStatus.status === 'connected'

  // Time calculator cell: for active/pending schedules show the approximate
  // run duration and the estimated finish time (start → end of one campaign).
  const scheduleEstimateCell = (schedule) => {
    if (!['pending', 'active'].includes(schedule.status)) return <span className="muted-copy">—</span>
    const estimate = scheduleEstimates[schedule.id]
    if (!estimate) return <span className="muted-copy">Calculating…</span>
    return (
      <span className="schedule-estimate">
        <strong>~{estimate.durationLabel}</strong>
        {estimate.contacts > 0 && <small>{estimate.contacts} contacts</small>}
        {estimate.endAt
          ? <small>ends approx. {new Date(estimate.endAt).toLocaleString()}</small>
          : <small>paused — resume to see end time</small>}
      </span>
    )
  }

  // Builder stepper: progress is read from the form's existing state only.
  const audienceReady = Boolean(name.trim() && upload)
  const messageReady = Boolean(template.trim()) && (allowMissingFields || !Object.values(missingByField).some((count) => count > 0))
  const timingReady = scheduleType === 'once' ? Boolean(runAt) : scheduleType === 'recurring' && recurrenceMode === 'custom' ? Boolean(customCron.trim()) : true
  const stepDone = { audience: audienceReady, message: messageReady, safety: audienceReady && messageReady && timingReady, review: false }
  const firstOpenStep = BUILDER_STEPS.findIndex((step) => !stepDone[step.id])
  const builderSteps = BUILDER_STEPS.map((step, index) => ({
    ...step,
    hint: step.id === 'audience' && upload ? `${upload.countsByReason?.valid ?? upload.valid} contacts` : step.hint,
    state: stepDone[step.id] ? 'done' : index === firstOpenStep ? 'current' : 'upcoming',
  }))

  return (
    <div className="campaign-workspace">
      <div className="campaign-toolbar">
        <div>
          <p className="eyebrow">Excel to WhatsApp</p>
          <h2>Campaign manager</h2>
          <p className="muted-copy">Upload contacts, personalize every row, then send from a persistent queue.</p>
        </div>
        <label className="primary-btn upload-btn">
          <Icon name="upload" size={16} />
          {busy ? 'Working...' : 'Choose XLSX file'}
          <input type="file" accept=".xlsx" onChange={uploadExcel} disabled={busy} />
        </label>
      </div>

      {message.text && <div className={`notice ${message.type}`}>{message.text}</div>}
      {duplicateDialog && <Modal onClose={() => setDuplicateDialog(null)} labelledBy="duplicate-dialog-title">
          <div className="panel-header"><div><p className="eyebrow">Create editable draft</p><h2 id="duplicate-dialog-title">Duplicate {duplicateDialog.name}</h2></div><button type="button" className="secondary-btn" onClick={() => setDuplicateDialog(null)}>Close</button></div>
          <label className="form-label">Draft name<input value={duplicateName} onChange={(event) => setDuplicateName(event.target.value)} /></label>
          <label className="form-label">Recipients<select value={duplicateContacts} onChange={(event) => setDuplicateContacts(event.target.value)}><option value="all">All original recipients</option><option value="unsent">Only unsent (pending, skipped, failed)</option><option value="failed">Only failed</option><option value="none">None — upload a new list in the editor</option></select></label>
          <label className="check-label"><input type="checkbox" checked={excludeMessaged} onChange={(event) => setExcludeMessaged(event.target.checked)} /> Exclude any contact already messaged in an earlier campaign</label>
          {excludeMessaged && <label className="form-label">Limit exclusion to selected campaigns (leave empty for all earlier campaigns)<select multiple size="3" value={excludeCampaignIds.map(String)} onChange={(event) => setExcludeCampaignIds(Array.from(event.target.selectedOptions, option => Number(option.value)))}>{campaignList.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <div className="button-row"><button type="button" className="primary-btn" disabled={busy} onClick={duplicateCampaign}>Create draft</button><button type="button" className="secondary-btn" onClick={() => setDuplicateDialog(null)}>Cancel</button></div>
      </Modal>}

      <div className="campaign-layout">
        <section className="panel campaign-builder">
          <div className="panel-header"><div><p className="eyebrow">New campaign</p><h2>Build your campaign</h2></div><span className="file-note">{file?.name || 'No file selected'}</span></div>
          <ol className="builder-stepper" aria-label="Campaign steps">
            {builderSteps.map((step, index) => <li key={step.id} className={`builder-step-link ${step.state}`}><a href={`#builder-${step.id}`} onClick={(event) => { event.preventDefault(); scrollToSection(`builder-${step.id}`) }} aria-current={step.state === 'current' ? 'step' : undefined} aria-label={`Step ${index + 1}: ${step.title}${step.state === 'done' ? ' (done)' : ''}`}><span className="step-index" aria-hidden="true">{step.state === 'done' ? <Icon name="check" size={14} /> : index + 1}</span><span className="step-text"><strong>{step.title}</strong><small>{step.hint}</small></span></a></li>)}
          </ol>
          <form onSubmit={createCampaign}>
            {whatsappStatus.businessStatus !== 'connected' && <div className="notice warning">WhatsApp Web is an unofficial linked-device connection. WhatsApp can restrict or ban numbers that send bulk messages through it, and it gives no quality or rate-limit warnings. For campaigns, connect the official WhatsApp Business Platform (Cloud API). <button type="button" onClick={() => onNavigate?.('WhatsApp Connection')}>Open Connection</button></div>}
            <fieldset className="builder-step" id="builder-audience" tabIndex={-1}>
              <legend><span className="step-index" aria-hidden="true">1</span>Audience</legend>
              <p className="builder-step-help">Name the campaign and choose who receives it.</p>
              <label className="form-label">Campaign name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Dealer outreach - August" required /></label>
              <div className="upload-row"><label className="secondary-btn upload-btn"><Icon name="upload" size={16} />{upload ? 'Replace Excel file' : 'Choose Excel file'}<input type="file" accept=".xlsx" onChange={uploadExcel} disabled={busy} /></label><span className="file-note">{file?.name || 'No Excel file chosen yet'}</span></div>
              <label className="form-label">Country code for phone numbers<select value={uploadCountryCode} onChange={changeUploadCountry} className="country-select"><option value="">Account default</option>{accountCountries.map((country) => <option key={`${country.name}-${country.dialCode}`} value={country.dialCode}>{country.name} (+{country.dialCode})</option>)}</select><small>{uploadCountryCode && uploadCountryCode !== '' ? `Numbers without a country code will be formatted as +${uploadCountryCode} …; numbers that already include one are left unchanged.` : 'Uses the account default from Settings. Change it before uploading to apply it to this file.'}</small></label>
              {upload && <div className="validation-summary">
              <strong>{upload.countsByReason?.valid ?? upload.valid} valid</strong>
              <span>{upload.countsByReason?.blank ?? 0} blank</span>
              <span>{upload.countsByReason?.['too short'] ?? 0} too short</span>
              <span>{upload.countsByReason?.['too long'] ?? 0} too long</span>
              <span>{upload.countsByReason?.duplicate ?? upload.duplicates} duplicates</span>
              <span>{upload.countsByReason?.['not a mobile number'] ?? 0} not mobile</span>
              <span>Phone column: {upload.phoneColumn}</span>
              {upload.rejectedRowCount > 0 && <button type="button" className="secondary-btn" onClick={downloadRejectedRows}>Download rejected CSV ({upload.rejectedRowCount})</button>}
              </div>}
              {upload && <div className="notice info upload-formatting-notice">{upload.formattingNotice || `${upload.valid} contacts found. Numbers will be formatted as +${upload.countryCode || uploadCountryCode || '91'} XXXXXXXXXX unless they already include a country code.`} Change the country selector above to re-format against a different code.</div>}
              {upload?.ignoredSheets?.length > 0 && <div className="notice warning">Skipped sheets without a phone-number header: {upload.ignoredSheets.join(', ')}.</div>}
              <label className="check-label"><input type="checkbox" checked={excludeMessaged} onChange={(event) => setExcludeMessaged(event.target.checked)} /> Exclude contacts already messaged in any earlier campaign</label>
              {excludeMessaged && <label className="form-label">Limit exclusion to selected campaigns (leave empty for all earlier campaigns)<select multiple size="3" value={excludeCampaignIds.map(String)} onChange={(event) => setExcludeCampaignIds(Array.from(event.target.selectedOptions, option => Number(option.value)))}>{campaignList.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            </fieldset>
            <fieldset className="builder-step" id="builder-message" tabIndex={-1}>
              <legend><span className="step-index" aria-hidden="true">2</span>Message</legend>
              <p className="builder-step-help">Write the message once; fields like {'{{name}}'} fill in for every contact.</p>
              <label className="form-label">Message template<textarea value={template} onChange={(event) => setTemplate(event.target.value)} required /></label>
              <div className="field-panel inline-fields">
              <h3>Detected fields</h3>
              {upload?.dynamicFields?.length ? <div className="field-list">{upload.dynamicFields.map((field) => <button key={field} type="button" className="field-chip" onClick={() => setTemplate((current) => `${current} {{${field}}}`)}>{`{{${field}}}`}</button>)}</div> : <small>Upload an XLSX file to detect every header automatically.</small>}
              </div>
              {Object.entries(missingByField).filter(([, count]) => count > 0).map(([field, count]) => <div className="missing-warning" key={field}>Warning: {count} contacts have no value for {`{{${field}}}`}. Creating this campaign requires explicit approval.</div>)}
              {Object.values(missingByField).some((count) => count > 0) && <label className="check-label"><input type="checkbox" checked={allowMissingFields} onChange={(event) => setAllowMissingFields(event.target.checked)} /> Allow unresolved fields to remain in messages</label>}
              {whatsappStatus.businessStatus === 'connected' && <div className="field-panel inline-fields">
              <h3>Approved template (Business API)</h3>
              <small>Outside the 24-hour customer service window WhatsApp only delivers approved templates. When you name one, recipients get that template instead of the message text above.</small>
              <label className="form-label">Template name<input value={waTemplateName} onChange={(event) => setWaTemplateName(event.target.value)} placeholder="dealer_offer_october" /></label>
              <label className="form-label">Language code<input value={waTemplateLanguage} onChange={(event) => setWaTemplateLanguage(event.target.value)} placeholder="en" /></label>
              <label className="form-label">Template variables, one per line ({'{{1}}'}, {'{{2}}'} …)<textarea value={waTemplateParams} onChange={(event) => setWaTemplateParams(event.target.value)} placeholder={'{{name}}\n{{company}}'} /><small>Use your Excel columns, for example {'{{name}}'}.</small></label>
              </div>}
              <div className="field-panel inline-fields">
              <div className="panel-header"><h3>Campaign media</h3><label className="secondary-btn upload-btn">{mediaFile ? 'Replace file' : 'Choose file'}<input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={uploadMedia} disabled={busy} /></label></div>
              {mediaPreview && mediaType === 'image' ? <img className="media-thumb" src={mediaPreview} alt="Campaign preview" /> : mediaPreview && mediaType === 'document' ? <div className="media-document-preview"><div>📄</div><small>{mediaFilename}</small></div> : <small>Optional JPEG, PNG, or WEBP image (up to 5 MB) or PDF document (up to 16 MB).</small>}
              </div>
              <div className="field-panel inline-fields">
              {whatsappStatus.businessStatus === 'connected' ? <>
              <div className="panel-header"><h3>Buttons (Business API only)</h3>{buttons.length < 3 && <button type="button" className="secondary-btn" onClick={() => setButtons([...buttons, { type: 'quick_reply', text: '', url: '' }])}>Add button</button>}</div>
              {buttons.map((button, index) => <div className="button-config" key={index}><select value={button.type} onChange={(event) => setButtons(buttons.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item))}><option value="quick_reply">Quick Reply</option><option value="url">URL</option></select><input value={button.text} onChange={(event) => setButtons(buttons.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} placeholder="Button text" />{button.type === 'url' && <input value={button.url} onChange={(event) => setButtons(buttons.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item))} placeholder="https://example.com" />}<button type="button" className="danger-btn" onClick={() => setButtons(buttons.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></div>)}
              <small>Buttons only send on the WhatsApp Business API provider — ignored when sending via WhatsApp Web.</small>
              </> : <>
              <div className="panel-header"><h3>Buttons (Business API only)</h3></div>
              <small>Connect WhatsApp Business API to use buttons</small>
              </>}
              </div>
            </fieldset>
            <fieldset className="builder-step" id="builder-safety" tabIndex={-1}>
              <legend><span className="step-index" aria-hidden="true">3</span>Safety</legend>
              <p className="builder-step-help">When to send, and the limits that protect your WhatsApp number.</p>
              <label className="form-label">Send timing<select value={scheduleType} onChange={(event) => setScheduleType(event.target.value)}><option value="now">Start now</option><option value="queue">Add to queue</option><option value="once">Schedule once</option><option value="recurring">Recurring</option></select></label>
              {scheduleType === 'once' && <label className="form-label">Run at<input type="datetime-local" value={runAt} min={new Date(Date.now() + 60000).toISOString().slice(0, 16)} onChange={(event) => setRunAt(event.target.value)} required /></label>}
              {scheduleType === 'recurring' && <div className="field-panel inline-fields"><label className="form-label">Recurrence<select value={recurrenceMode} onChange={(event) => setRecurrenceMode(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="custom">Custom cron expression</option></select></label>{recurrenceMode !== 'custom' && <label className="form-label">Time<input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} /></label>}{recurrenceMode === 'weekly' && <label className="form-label">Day<select value={scheduleWeekday} onChange={(event) => setScheduleWeekday(event.target.value)}><option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option></select></label>}{recurrenceMode === 'monthly' && <label className="form-label">Day of month<input type="number" min="1" max="28" value={scheduleMonthDay} onChange={(event) => setScheduleMonthDay(event.target.value)} /></label>}{recurrenceMode === 'custom' && <label className="form-label">Cron expression<input value={customCron} onChange={(event) => setCustomCron(event.target.value)} placeholder="*/2 * * * *" required /></label>}<small className="muted-copy">Cron: {recurrenceMode === 'custom' ? customCron || 'Enter a cron expression' : (() => { const [hour, minute] = scheduleTime.split(':'); if (recurrenceMode === 'weekly') return `${minute} ${hour} * * ${scheduleWeekday}`; if (recurrenceMode === 'monthly') return `${minute} ${hour} ${scheduleMonthDay} * *`; return `${minute} ${hour} * * *` })()}</small></div>}
              <label className="form-label">Pause after identical send errors<input type="number" min="1" step="1" value={circuitBreakerThreshold} onChange={(event) => setCircuitBreakerThreshold(event.target.value)} required /><small>Default: 5. “Number is not registered” remains a contact-level error.</small></label>
              <div className="field-panel inline-fields sending-safety">
              <h3>Sending safety</h3>
              <label className="check-label"><input type="checkbox" checked={respectRecipientHours} onChange={(event) => setRespectRecipientHours(event.target.checked)} /> Send only during business hours in each recipient’s country</label>
              <label className="form-label">Pause the campaign when recent failures reach<select value={failureRatePause} onChange={(event) => setFailureRatePause(event.target.value)}><option value="0.3">30% of the last 20 messages</option><option value="0.5">50% of the last 20 messages (default)</option><option value="0.7">70% of the last 20 messages</option><option value="0">Never</option></select></label>
              <label className="form-label">Pause after every … messages<input type="number" min="0" max="1000" step="1" value={cooldownEvery} onChange={(event) => setCooldownEvery(event.target.value)} /><small>0 = no pauses between batches.</small></label>
              <label className="form-label">Pause length (minutes)<input type="number" min="1" max="240" step="1" value={cooldownMinutes} onChange={(event) => setCooldownMinutes(event.target.value)} disabled={!(Number(cooldownEvery) > 0)} /></label>
              <small>Messages go out one at a time with your delay and hourly and daily limits. WhatsApp rate limits, restriction warnings and quality drops pause the campaign automatically, and only opted-in contacts are messaged.</small>
              </div>
              {whatsappStatus.businessStatus !== 'connected' && Number(upload?.valid || 0) > 200 && <div className="notice warning">This campaign contains more than 200 contacts and carries increased WhatsApp Web ban risk. Consider using the WhatsApp Business API.</div>}
            </fieldset>
            <fieldset className="builder-step" id="builder-review" tabIndex={-1}>
              <legend><span className="step-index" aria-hidden="true">4</span>Review</legend>
              <dl className="review-summary">
                <div><dt>Campaign</dt><dd>{name.trim() || 'Not named yet'}</dd></div>
                <div><dt>Recipients</dt><dd>{upload ? `${upload.countsByReason?.valid ?? upload.valid} valid contacts` : 'No Excel file yet'}</dd></div>
                <div><dt>Sending</dt><dd>{scheduleType === 'now' ? 'Starts now' : scheduleType === 'queue' ? 'Added to the queue' : scheduleType === 'once' ? (runAt ? `Once, ${new Date(runAt).toLocaleString()}` : 'Once (choose a time)') : 'Recurring'}</dd></div>
                <div><dt>Sends through</dt><dd>{whatsappStatus.businessStatus === 'connected' ? 'WhatsApp Business Platform' : 'WhatsApp Web'}</dd></div>
              </dl>
              {scheduleType === 'now' && whatsappStatus.status !== 'connected' && whatsappStatus.businessStatus !== 'connected' && <div className="notice warning">Connect WhatsApp before starting now. You can still add this campaign to the queue or schedule it.</div>}
              <div className="button-row"><button type="button" className="secondary-btn" onClick={previewMessages} disabled={!upload || busy}>Preview messages</button><button className="primary-btn" disabled={!upload || !name.trim() || busy || (scheduleType === 'now' && whatsappStatus.status !== 'connected' && whatsappStatus.businessStatus !== 'connected')}>{scheduleType === 'now' ? 'Create and start' : scheduleType === 'queue' ? 'Add to queue' : 'Create schedule'}</button></div>
            </fieldset>
          </form>
        </section>

        <section className="panel preview-panel">
          <div className="panel-header"><div><p className="eyebrow">Preview</p><h2>How it will look</h2></div><span className="file-note">First 5 valid rows</span></div>
          {previews.length ? <div className="preview-list">{mediaPreview && <img className="preview-media" src={mediaPreview} alt="Campaign image preview" />}{previews.map((item) => <article key={item.phone} className="message-preview"><strong>{item.name || item.phone}</strong><small>{item.phone}</small><p>{item.rendered}</p>{item.missingFields.length > 0 && <em>Missing: {item.missingFields.join(', ')}</em>}</article>)}</div> : <div className="empty-preview">Upload a file and preview the rendered message before creating the queue.</div>}
        </section>
      </div>

      <section className="panel queue-panel">
        <div className="panel-header">
          <div><h2>Persistent campaign queue</h2><span className="file-note">{campaignList.length} campaigns</span></div>
          {selectedCampaign && <div className="button-row">
            {selectedCampaign.media_path && selectedCampaign.provider === 'web' && <button className="secondary-btn" onClick={testCampaignMedia} disabled={busy || whatsappStatus.status !== 'connected'} title={whatsappStatus.status !== 'connected' ? 'Connect WhatsApp Web to send a test.' : 'Send the first campaign message and attachment to your connected number.'}>Send test to my number</button>}
            <button className="secondary-btn" onClick={() => controlCampaign('start')} disabled={busy || !selectedProviderConnected || !['draft', 'paused', 'stopped'].includes(selectedCampaign.status)} title={!selectedProviderConnected ? 'Connect WhatsApp before starting this campaign.' : undefined}>Start</button>
            <button className="secondary-btn" onClick={retryFailedContacts} disabled={busy || !(Number(selectedCampaign.failed) > 0) || !['failed', 'completed_with_errors', 'completed', 'stopped'].includes(selectedCampaign.status)}>Retry failed ({Number(selectedCampaign.failed) || 0})</button>
            <button className="secondary-btn" onClick={() => controlCampaign('pause')} disabled={busy || selectedCampaign.status !== 'running'}>Pause</button>
            <button className="secondary-btn" onClick={() => controlCampaign('resume')} disabled={busy || selectedCampaign.status !== 'paused' || resumeLocked} title={resumeLocked ? `WhatsApp rate-limited this campaign. Resume after ${new Date(selectedCampaign.resume_after).toLocaleTimeString()}.` : undefined}>Resume</button>
            <button className="danger-btn" onClick={() => controlCampaign('stop')} disabled={busy || !['running', 'paused'].includes(selectedCampaign.status)}>Stop</button>
          </div>}
        </div>
        {selectedCampaign && !selectedProviderConnected && <div className="notice warning campaign-connection-notice" role="status">
          <span>{selectedCampaign.pause_reason === 'whatsapp_disconnected' ? 'WhatsApp disconnected — reconnect to continue.' : 'WhatsApp is not connected. Connect before starting this campaign.'}</span>
          <button type="button" className="secondary-btn" onClick={() => onNavigate?.('WhatsApp Connection')}>Open WhatsApp Connection</button>
        </div>}
        {selectedCampaign?.last_error && <div className="notice warning">{selectedCampaign.last_error}</div>}
        {selectedIds.length > 0 && <div className="button-row"><span>{selectedIds.length} selected</span><button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button></div>}
        <div className="campaign-table-wrap">
          <table>
            <thead><tr><th><input type="checkbox" aria-label="Select all campaigns on this page" checked={campaignList.length > 0 && selectedIds.length === campaignList.length} onChange={toggleAllCampaigns} /></th><th>Campaign</th><th>Provider</th><th>Status</th><th>Progress</th><th>Sent</th><th>Failed</th><th>Queue</th><th>Actions</th></tr></thead>
            <tbody>{campaignList.map((campaign) => <tr key={campaign.id} className={selectedCampaign?.id === campaign.id ? 'selected-row' : ''} onClick={() => setSelectedCampaign(campaign)}>
              <td data-label="Select" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${campaign.name}`} checked={selectedIds.includes(campaign.id)} onChange={() => toggleCampaign(campaign.id)} /></td>
              <td data-label="Campaign"><strong>{campaign.name}</strong><small>Created {campaign.created_at}</small>{campaign.pause_reason && <small className="campaign-error">Paused: {campaign.pause_reason.replaceAll('_', ' ')}</small>}{campaign.last_error && <small className="campaign-error">{campaign.last_error}</small>}{campaign.pause_reason === 'whatsapp_disconnected' && <small>WhatsApp disconnected — reconnect to continue</small>}</td>
              <td data-label="Provider">{campaign.provider || 'web'}</td>
              <td data-label="Status"><span className={statusClass(campaign.status)}>{campaign.status.replaceAll('_', ' ')}</span></td>
              <td data-label="Progress">{campaign.processed} / {campaign.total_contacts}</td><td data-label="Sent">{campaign.sent}{campaign.delivered != null && <small>{campaign.delivered} delivered</small>}</td><td data-label="Failed">{campaign.failed}</td>
              <td data-label="Queue">{campaign.status === 'queued' ? <div onClick={(event) => event.stopPropagation()}><strong>#{campaign.queue_position}</strong>{queueStartEstimate(campaign) && <small>Est. start {queueStartEstimate(campaign).toLocaleString()}</small>}<div className="button-row"><button className="secondary-btn" aria-label="Move up" disabled={campaign.queue_position <= 1} onClick={(event) => moveQueuedCampaign(campaign, -1, event)}>↑</button><button className="secondary-btn" aria-label="Move down" disabled={campaign.queue_position >= queuedCampaigns.length} onClick={(event) => moveQueuedCampaign(campaign, 1, event)}>↓</button><button className="secondary-btn" onClick={(event) => removeQueuedCampaign(campaign, event)}>Remove</button></div></div> : '—'}</td>
              <td data-label="Actions" onClick={(event) => event.stopPropagation()}>{campaign.status === 'draft' && <button className="secondary-btn" onClick={(event) => editCampaignDraft(campaign, event)}>Edit</button>}{['completed', 'completed_with_errors', 'failed', 'stopped'].includes(campaign.status) && <button className="secondary-btn" onClick={(event) => openDuplicateDialog(campaign, event)}>Duplicate</button>}</td>
            </tr>)}</tbody>
          </table>
          {!campaignList.length && <EmptyState icon="📣" title="No campaigns yet" description="Create your first campaign to start reaching customers. Upload an Excel list, personalize the message, and send — or schedule it for later." actions={[{ label: 'Create your first campaign', onClick: () => document.querySelector('.campaign-builder input')?.focus() }]} />}
        </div>
        {selectedCampaign && <div className="campaign-detail">
          {selectedCampaign.status === 'paused' && selectedCampaign.pause_reason && <div className="notice warning status-banner" role="status"><strong>Paused: </strong>{pauseReasonText(selectedCampaign.pause_reason)}{resumeLocked ? ` You can resume after ${new Date(selectedCampaign.resume_after).toLocaleTimeString()}.` : ''}</div>}
          {selectedWaiting && <div className="notice info status-banner" role="status"><strong>Waiting: </strong>{WAITING_TEXT[selectedWaiting.reason] || selectedWaiting.reason}{selectedWaiting.until ? `; sending resumes around ${new Date(selectedWaiting.until).toLocaleTimeString()}.` : '.'}</div>}
          {selectedCampaign.status === 'running' && queueStatus?.warning && queueStatus.currentCampaignId === selectedCampaign.id && <div className="notice warning status-banner" role="status">{queueStatus.warning}</div>}
          <div className="panel-header">
            <div><h3>{selectedCampaign.name} <span className={statusClass(selectedCampaign.status)}>{String(selectedCampaign.status || '').replaceAll('_', ' ')}</span></h3><span className="file-note">Sending through: {selectedCampaign.provider || 'web'}</span></div>
            <div className="campaign-progress-summary">
              <strong>{selectedCampaign.processed} / {selectedCampaign.total_contacts} processed</strong>
              <small>{campaignEstimate ? `${campaignEstimate.contacts} remaining` : 'Calculating remaining contacts…'}</small>
              {campaignEstimate?.endAt && <small>Estimated finish: {new Date(campaignEstimate.endAt).toLocaleString()}</small>}
              {campaignEstimate && !campaignEstimate.endAt && <small>Paused — reconnect/resume to estimate finish</small>}
            </div>
          </div>
          <div className={`campaign-progress${selectedCampaign.status === 'running' ? ' is-live' : ''}`} role="progressbar" aria-label="Campaign progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={campaignPercent}><i style={{ width: `${campaignPercent}%` }} /></div>
          <div className="stats-grid campaign-delivery-stats">{campaignTiles.map(([label, value, accent]) => <article className={`stat-card ${accent}`} key={label} title={['Delivered', 'Read'].includes(label) && !deliveryTracked ? 'Run supabase-campaign-delivery-migration.sql to track delivery receipts.' : undefined}><span>{label}</span><strong>{value}</strong></article>)}</div>
          {draftEdit && selectedCampaign.status === 'draft' && draftEditCampaignId === selectedCampaign.id ? <div className="field-panel draft-editor">
            <h3>Edit draft</h3>
            <label className="form-label">Campaign name<input value={draftEdit.name} onChange={(event) => setDraftEdit({ ...draftEdit, name: event.target.value })} /></label>
            <label className="form-label">Message template<textarea value={draftEdit.template_message} onChange={(event) => setDraftEdit({ ...draftEdit, template_message: event.target.value })} /></label>
            <div className="inline-fields">
              <label className="form-label">Delay between messages (ms)<input type="number" min="17500" value={draftEdit.settings.delayBetweenMessages ?? 17500} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, delayBetweenMessages: Number(event.target.value) } })} /></label>
              <label className="form-label">Max per hour<input type="number" min="1" value={draftEdit.settings.maxPerHour ?? 50} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, maxPerHour: Number(event.target.value) } })} /></label>
              <label className="form-label">Max per day<input type="number" min="1" value={draftEdit.settings.maxPerDay ?? 175} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, maxPerDay: Number(event.target.value) } })} /></label>
            </div>
            <div className="field-panel inline-fields">
              <h4>Sending safety</h4>
              <label className="check-label"><input type="checkbox" checked={draftEdit.settings.respectRecipientTimezone !== false} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, respectRecipientTimezone: event.target.checked } })} /> Send only during business hours in each recipient’s country</label>
              <label className="form-label">Pause after every … messages<input type="number" min="0" max="1000" value={draftEdit.settings.cooldownEvery ?? 0} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, cooldownEvery: Number(event.target.value) } })} /></label>
              <label className="form-label">Pause length (minutes)<input type="number" min="1" max="240" value={draftEdit.settings.cooldownMinutes ?? 10} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, cooldownMinutes: Number(event.target.value) } })} /></label>
              {selectedCampaign.provider === 'business' && <>
                <label className="form-label">Approved template name<input value={draftEdit.settings.waTemplate?.name || ''} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, waTemplate: { language: 'en', bodyParams: [], ...(draftEdit.settings.waTemplate || {}), name: event.target.value } } })} placeholder="Leave empty to send the message text" /></label>
                <label className="form-label">Template language<input value={draftEdit.settings.waTemplate?.language || 'en'} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, waTemplate: { name: '', bodyParams: [], ...(draftEdit.settings.waTemplate || {}), language: event.target.value } } })} /></label>
                <label className="form-label">Template variables, one per line<textarea value={(draftEdit.settings.waTemplate?.bodyParams || []).join('\n')} onChange={(event) => setDraftEdit({ ...draftEdit, settings: { ...draftEdit.settings, waTemplate: { name: '', language: 'en', ...(draftEdit.settings.waTemplate || {}), bodyParams: event.target.value.split('\n') } } })} /></label>
              </>}
            </div>
            <div className="field-panel inline-fields">
              <div className="panel-header"><h4>Recipients</h4><label className="secondary-btn upload-btn">Upload Excel<input type="file" accept=".xlsx" onChange={uploadDraftExcel} disabled={busy} /></label></div>
              <select value={draftRecipientsMode} onChange={(event) => setDraftRecipientsMode(event.target.value)}><option value="replace">Replace current recipients</option><option value="add">Add to current recipients</option></select>
              {draftExcelPath && <small>Validated replacement list is ready to save.</small>}
              <label className="check-label"><input type="checkbox" checked={excludeMessaged} onChange={(event) => setExcludeMessaged(event.target.checked)} /> Exclude contacts already messaged in earlier campaigns</label>
              {excludeMessaged && <label className="form-label">Limit exclusion to selected campaigns (leave empty for all earlier campaigns)<select multiple size="3" value={excludeCampaignIds.map(String)} onChange={(event) => setExcludeCampaignIds(Array.from(event.target.selectedOptions, option => Number(option.value)))}>{campaignList.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
              {!Number(selectedCampaign.total_contacts) && !draftExcelPath && <small>Upload a recipient list before starting or queueing this empty draft.</small>}
            </div>
            <div className="field-panel inline-fields">
              <div className="panel-header"><h4>Attachment</h4><label className="secondary-btn upload-btn">Replace attachment<input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={uploadDraftMedia} disabled={busy} /></label></div>
              {draftEdit.media_filename && <div className="button-row"><span>{draftEdit.media_filename}</span><button type="button" className="danger-btn" onClick={() => setDraftEdit({ ...draftEdit, media_path: '', media_bucket: '', media_object_path: '', media_type: '', media_filename: '', media_mimetype: '' })}>Remove attachment</button></div>}
            </div>
            <div className="field-panel inline-fields">
              <div className="panel-header"><h4>Business API buttons</h4>{draftEdit.buttons.length < 3 && <button type="button" className="secondary-btn" onClick={() => setDraftEdit({ ...draftEdit, buttons: [...draftEdit.buttons, { type: 'quick_reply', text: '', url: '' }] })}>Add button</button>}</div>
              {draftEdit.buttons.map((button, index) => <div className="button-config" key={index}><select value={button.type} onChange={(event) => setDraftEdit({ ...draftEdit, buttons: draftEdit.buttons.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item) })}><option value="quick_reply">Quick Reply</option><option value="url">URL</option></select><input value={button.text} onChange={(event) => setDraftEdit({ ...draftEdit, buttons: draftEdit.buttons.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item) })} placeholder="Button text" />{button.type === 'url' && <input value={button.url} onChange={(event) => setDraftEdit({ ...draftEdit, buttons: draftEdit.buttons.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item) })} placeholder="https://example.com" />}<button type="button" className="danger-btn" onClick={() => setDraftEdit({ ...draftEdit, buttons: draftEdit.buttons.filter((_, itemIndex) => index !== itemIndex) })}>Remove</button></div>)}
            </div>
            <div className="button-row"><button className="primary-btn" disabled={busy} onClick={() => saveCampaignDraft('save')}>Save draft</button><button className="secondary-btn" disabled={busy || !selectedProviderConnected || (!Number(selectedCampaign.total_contacts) && !draftExcelPath)} title={!selectedProviderConnected ? 'Connect WhatsApp before starting.' : undefined} onClick={() => saveCampaignDraft('start')}>Save and Start</button><button className="secondary-btn" disabled={busy || (!Number(selectedCampaign.total_contacts) && !draftExcelPath)} onClick={() => saveCampaignDraft('queue')}>Save and Add to queue</button></div>
          </div> : <p className="detail-template">{selectedCampaign.template_message}</p>}
          <div className="campaign-table-wrap"><table><thead><tr><th>Contact</th><th>Phone</th><th>Result</th><th>Error</th></tr></thead><tbody>{campaignContacts.map((contact) => <tr key={contact.id}><td data-label="Contact">{contact.name || 'Unknown'}</td><td data-label="Phone">{contact.phone}</td><td data-label="Result"><span className={statusClass(contact.status)}>{recipientStatusLabel(contact)}</span></td><td data-label="Error">{contact.last_error || ''}</td></tr>)}</tbody></table></div>
        </div>}
      </section>
      <section className="panel queue-panel"><div className="panel-header"><div><h2>Scheduled campaigns</h2><span className="file-note">{schedules.length} schedules</span></div></div>{selectedScheduleIds.length > 0 && <div className="button-row"><span>{selectedScheduleIds.length} selected</span><button className="danger-btn" onClick={bulkDeleteSchedules}>Delete selected</button></div>}<div className="campaign-table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all schedules" checked={schedules.length > 0 && selectedScheduleIds.length === schedules.length} onChange={toggleAllSchedules} /></th><th>Name</th><th>Type</th><th>Next run</th><th>Est. one campaign run</th><th>Status</th><th>Last run</th><th>Actions</th></tr></thead><tbody>{schedules.map((schedule) => <tr key={schedule.id} title={schedule.last_error || undefined}><td data-label="Select"><input type="checkbox" aria-label={`Select ${schedule.name}`} checked={selectedScheduleIds.includes(schedule.id)} onChange={() => toggleSchedule(schedule.id)} /></td><td data-label="Name"><strong>{schedule.name}</strong>{schedule.last_error && <small className="schedule-error">{schedule.last_error}</small>}</td><td data-label="Type">{schedule.schedule_type}</td><td data-label="Next run">{formatDate(schedule.next_run_at)}</td><td data-label="Est. one campaign run">{scheduleEstimateCell(schedule)}</td><td data-label="Status"><span className={statusClass(schedule.status)}>{schedule.status}</span></td><td data-label="Last run">{formatDate(schedule.last_run_at)}</td><td data-label="Actions"><div className="button-row">{schedule.status === 'failed' && <button className="secondary-btn" onClick={() => retrySchedule(schedule.id)}>Retry now</button>}{['active', 'pending'].includes(schedule.status) && <button className="secondary-btn" onClick={() => scheduleAction(schedule.id, 'pause')}>Pause</button>}{schedule.status === 'paused' && <button className="secondary-btn" onClick={() => scheduleAction(schedule.id, 'resume')}>Resume</button>}{!['cancelled', 'completed', 'failed'].includes(schedule.status) && <button className="danger-btn" onClick={() => scheduleAction(schedule.id, 'cancel', 'POST')}>Cancel</button>}<button className="danger-btn" onClick={() => deleteSchedule(schedule.id)}>Delete</button></div></td></tr>)}</tbody></table>{!schedules.length && <EmptyState icon="🗓️" title="No scheduled campaigns yet" description="When you create a campaign with “Schedule once” or “Recurring” timing, it will show up here." />}</div></section>
    </div>
  )
}

// Domain-specific, actionable wording for WhatsApp Business API setup errors.
// These stay specific (they help the user fix their credentials) but never
// include raw stack traces, JSON, or internal state strings.
const WHATSAPP_BUSINESS_ERROR_RULES = [
  { match: 'phone number id', message: 'The Phone Number ID doesn\'t look right. Copy it from your Meta Business dashboard and try again.' },
  { match: 'access token', message: "Meta rejected the access token. Double-check it (and that it hasn't expired), then try again." },
  { match: 'verify token', message: 'The webhook verify token doesn\'t match. Re-copy it from your Meta webhook settings.' },
  { match: 'authentication', message: "Meta rejected the access token. Double-check it (and that it hasn't expired), then try again." },
]

function ConnectionView() {
  const [status, setStatus] = useState({ provider: '', status: 'checking', qrAvailable: false })
  const [qr, setQr] = useState('')
  const qrRef = useRef('')
  const statusRef = useRef(status)
  const pollingRef = useRef(false)
  const [credentials, setCredentials] = useState({ phoneNumberId: '', accessToken: '', verifyToken: '' })
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)

  const loadStatus = async () => {
    if (pollingRef.current) return
    pollingRef.current = true
    try {
      const nextStatus = await apiFetch('/whatsapp/status')
      console.log('[wa-qr] poll /whatsapp/status →', nextStatus)
      statusRef.current = nextStatus
      setStatus(nextStatus)
      if (nextStatus.status === 'connected' || !nextStatus.qrAvailable) {
        qrRef.current = ''
        setQr('')
      } else if (nextStatus.qrAvailable && !qrRef.current) {
        console.log('[wa-qr] server reports qrAvailable — fetching /whatsapp/qr')
        try {
          const qrResponse = await apiFetch('/whatsapp/qr')
          console.log('[wa-qr] /whatsapp/qr returned', qrResponse.qrDataUrl ? 'a QR data URL' : 'NOTHING')
          if (statusRef.current.status === 'connected' || !statusRef.current.qrAvailable) return
          qrRef.current = qrResponse.qrDataUrl || ''
          setQr(qrRef.current)
        } catch (error) {
          if (error.status !== 404) throw error
          qrRef.current = ''
          setQr('')
          setStatus((current) => ({ ...current, qrAvailable: false }))
        }
      }
    } catch (error) { console.error('[wa-qr] status/qr poll failed:', error); setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'WhatsApp connection', log: false }) }) }
    finally { pollingRef.current = false }
  }

  useEffect(() => {
    // DEBUG: make the QR transport visible. NOTE: this view has NO Socket.IO
    // connection and NO 'whatsapp:qr' listener — the QR only arrives via the
    // 4s polling loop below. If the server emits whatsapp:qr while this view
    // is mounted (Campaigns/Inbox sockets are unmounted), nobody receives it.
    console.log('[wa-qr] ConnectionView mounted — no Socket.IO socket in this view; QR display relies on 4s REST polling')
    loadStatus()
    const interval = window.setInterval(loadStatus, 4000)
    return () => window.clearInterval(interval)
  }, [])

  const connectWeb = async () => {
    setBusy(true)
    console.log('[wa-qr] Connect with QR clicked — POST /whatsapp/connect')
    // Lazily starts THIS user's own session; the QR appears in your room only.
    try { await apiFetch('/whatsapp/connect', { method: 'POST' }); console.log('[wa-qr] POST /whatsapp/connect OK'); setNotice({ type: 'success', text: 'Starting your WhatsApp session. Scan the QR code when it appears.' }); await loadStatus() } catch (error) { console.error('[wa-qr] POST /whatsapp/connect FAILED:', error); setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'WhatsApp connect', log: false }) }) } finally { setBusy(false) }
  }

  const loadQr = async () => {
    try {
      const response = await apiFetch('/whatsapp/qr')
      qrRef.current = response.qrDataUrl || ''
      setQr(qrRef.current)
    } catch (error) {
      if (error.message === 'No QR code available') {
        try {
          await apiFetch('/whatsapp/reconnect', { method: 'POST' })
          qrRef.current = ''
          setQr('')
          setNotice({ type: 'success', text: 'Generating a fresh QR code. Please wait a few seconds.' })
          return
        } catch (reconnectError) {
          setNotice({ type: 'error', text: reconnectError.message })
          return
        }
      }
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'QR refresh', custom: [{ match: 'no qr code available', message: 'No QR code is showing right now. Click “Refresh QR” in a few seconds — or disconnect and connect again.' }] }) })
    }
  }

  const testBusiness = async () => {
    setBusy(true)
    try { await apiFetch('/whatsapp/business/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }); setNotice({ type: 'success', text: 'Business API credentials are valid.' }) } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Business API test', custom: WHATSAPP_BUSINESS_ERROR_RULES }) }) } finally { setBusy(false) }
  }

  const connectBusiness = async () => {
    setBusy(true)
    try { await apiFetch('/whatsapp/business/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }); setNotice({ type: 'success', text: 'WhatsApp Business API connected.' }); await loadStatus() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Business API connect', custom: WHATSAPP_BUSINESS_ERROR_RULES }) }) } finally { setBusy(false) }
  }

  const disconnect = async () => {
    setBusy(true)
    try { await apiFetch('/whatsapp/disconnect', { method: 'POST' }); setNotice({ type: 'success', text: 'WhatsApp disconnected.' }); await loadStatus() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'WhatsApp disconnect' }) }) } finally { setBusy(false) }
  }

  return <div className="connection-workspace">
    <div><p className="eyebrow">One active connection</p><h2>Connect WhatsApp</h2><p className="muted-copy">Once connected, this WhatsApp number powers your Inbox, AI auto-replies, and Campaigns.</p></div>
    {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    <div className="connection-grid">
      <section className="panel connection-card"><div className="connection-heading"><span className="connection-icon"><Icon name="qr" size={22} /></span><div><h2>WhatsApp Web</h2><p className="muted-copy">Connect by scanning a QR code from your phone.</p></div></div><div className="qr-layout"><div className={`qr-frame${qr ? ' has-qr' : ''}`}>{qr ? <><img className="qr-image" src={qr} alt="WhatsApp Web QR code" /><span className="qr-scanline" aria-hidden="true" /></> : <div className="qr-placeholder"><Icon name="qr" size={40} /><span>{status.qrAvailable ? 'QR code available' : 'No QR code available'}</span></div>}</div><ol className="qr-steps"><li><span className="qr-step-num" aria-hidden="true">1</span>Open WhatsApp on your phone</li><li><span className="qr-step-num" aria-hidden="true">2</span>Go to Linked Devices</li><li><span className="qr-step-num" aria-hidden="true">3</span>Choose Link a Device and scan</li></ol></div><div className="connection-actions"><button className="primary-btn" onClick={connectWeb} disabled={busy}>Connect with QR</button><button className="secondary-btn" onClick={loadQr} disabled={busy || !status.qrAvailable}>Refresh QR</button></div></section>
      <section className="panel connection-card"><div className="connection-heading"><span className="connection-icon"><Icon name="cloud" size={22} /></span><div><h2>WhatsApp Business API</h2><p className="muted-copy">Use Meta's official Cloud API connection.</p></div></div><label className="form-label">Phone Number ID<input value={credentials.phoneNumberId} onChange={(event) => setCredentials({ ...credentials, phoneNumberId: event.target.value })} /></label><label className="form-label">Access Token<input type="password" value={credentials.accessToken} onChange={(event) => setCredentials({ ...credentials, accessToken: event.target.value })} /></label><label className="form-label">Webhook Verify Token<input type="password" value={credentials.verifyToken} onChange={(event) => setCredentials({ ...credentials, verifyToken: event.target.value })} /></label><div className="connection-actions"><button className="secondary-btn" onClick={testBusiness} disabled={busy}>Test Connection</button><button className="primary-btn" onClick={connectBusiness} disabled={busy}>Connect Business API</button></div></section>
    </div>
    <section className="panel active-connection"><div><p className="eyebrow">Current provider</p><h2>{status.provider || 'Loading...'}</h2><p className="muted-copy">Status: <ConnectionChip status={status.status} /></p></div><button className="danger-btn" onClick={() => { if (window.confirm('Disconnect WhatsApp? Campaigns and AI replies stop until you connect again.')) disconnect() }} disabled={busy || status.status === 'disconnected'}>Disconnect</button></section>
  </div>
}

function InboxView({ onNavigate }) {
  const [conversations, setConversations] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [threadOpen, setThreadOpen] = useState(false)
  // Salesperson Copilot brief (Feature: on-demand, one AI call per click)
  const [showCopilot, setShowCopilot] = useState(false)

  const loadConversations = async () => {
    try {
      const data = await apiFetch(`/conversations?limit=50&search=${encodeURIComponent(search)}`)
      setConversations((data.data || []).map((item) => ({ ...item, name: displayIdentity(item) })))
      if (!selectedId && data.data?.[0]) setSelectedId(data.data[0].id)
    } catch (error) { setNotice(friendlyErrorMessage(error, { context: 'Inbox' })) }
  }

  const loadSelected = async () => {
    if (!selectedId) return
    try {
      const [nextConversation, nextMessages] = await Promise.all([
        apiFetch(`/conversations/${selectedId}`),
        apiFetch(`/conversations/${selectedId}/messages?limit=50`),
      ])
      setConversation({ ...nextConversation, name: displayIdentity(nextConversation) })
      setMessages(nextMessages)
    } catch (error) { setNotice(friendlyErrorMessage(error, { context: 'Inbox' })) }
  }

  useEffect(() => {
    loadConversations()
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'], auth: socketAuth() })
    // DEBUG: connection lifecycle — connect_error means the server rejected
    // the handshake (usually auth), which also means no room join happened.
    socket.on('connect', () => console.log('[socket:Inbox] connected — id', socket.id))
    socket.on('connect_error', (error) => console.error('[socket:Inbox] connect_error:', error.message))
    const refresh = () => { loadConversations(); loadSelected() }
    const aiError = (event) => setNotice(event.error || 'AI provider unavailable. Check the AI configuration.')
    socket.on('message:new', refresh)
    socket.on('conversation:human_takeover', refresh)
    socket.on('conversation:ai_error', aiError)
    const interval = window.setInterval(refresh, 10000)

    // BUG 2: stop polling + socket refreshes once the session is invalidated
    // (sign-out or a fatal 401) — otherwise this loop keeps 401-ing forever.
    const stopPolling = () => {
      console.log('[inbox] session invalidated — stopping conversation polling')
      window.clearInterval(interval)
      socket.off('message:new', refresh)
      socket.off('conversation:human_takeover', refresh)
    }
    window.addEventListener(SESSION_INVALIDATED_EVENT, stopPolling)

    return () => {
      window.removeEventListener(SESSION_INVALIDATED_EVENT, stopPolling)
      socket.off('conversation:ai_error', aiError)
      socket.disconnect()
      window.clearInterval(interval)
    }
  }, [search, selectedId])

  useEffect(() => { loadSelected() }, [selectedId])

  const updateConversation = async (path, options) => {
    setBusy(true)
    try { await apiFetch(path, options); await loadSelected(); await loadConversations() } catch (error) { setNotice(friendlyErrorMessage(error, { context: 'Inbox' })) } finally { setBusy(false) }
  }

  const removeConversation = async (id) => {
    if (!window.confirm('Delete this conversation and its messages?')) return
    setBusy(true)
    try { await apiFetch(`/conversations/${id}`, { method: 'DELETE' }); if (selectedId === id) { setSelectedId(null); setConversation(null); setMessages([]); setThreadOpen(false) } await loadConversations(); setNotice('Conversation deleted.') } catch (error) { setNotice(friendlyErrorMessage(error, { context: 'Inbox' })) } finally { setBusy(false) }
  }

  const sendReply = async (event) => {
    event.preventDefault()
    if (!draft.trim() || !selectedId) return
    setBusy(true)
    try { await apiFetch(`/conversations/${selectedId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: draft.trim() }) }); setDraft(''); await loadSelected(); await loadConversations() } catch (error) { setNotice(friendlyErrorMessage(error, { context: 'Inbox' })) } finally { setBusy(false) }
  }

  const toggleAI = () => updateConversation(`/conversations/${selectedId}/ai`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !conversation?.ai_enabled }) })
  const takeOver = () => updateConversation(`/conversations/${selectedId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'human_takeover' }) })
  const resolve = () => updateConversation(`/conversations/${selectedId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) })

  return <div className={threadOpen ? 'inbox-workspace mobile-thread-open' : 'inbox-workspace'}>
    <div className="inbox-toolbar"><div><p className="eyebrow">Live conversations</p><h2>Inbox</h2></div><input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></div>
    {notice && <div className="notice error">{notice}</div>}
    <div className="inbox-layout">
      <aside className="panel conversation-sidebar"><h2>Conversations</h2>{conversations.map((item) => <div className="conversation-row" key={item.id}><button type="button" className={`conversation-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setThreadOpen(true) }}><span className="conversation-item-top"><strong>{displayIdentity(item)}</strong>{item.unread_count > 0 && <b>{item.unread_count}</b>}</span><small>{item.last_message || 'No messages yet'}</small>{item.status === 'human_takeover' && <em>Human attention required</em>}</button><button type="button" className="danger-btn" onClick={() => removeConversation(item.id)} disabled={busy}>Delete</button></div>)}{!conversations.length && <EmptyState icon="💬" title="No conversations yet" description="Once customers message your connected WhatsApp number, they'll appear here. Check back after your number is connected." actions={[{ label: 'Open WhatsApp Connection', variant: 'secondary', onClick: () => onNavigate?.('WhatsApp Connection') }] } />}</aside>
      <section className="panel chat-panel">{conversation ? <><div className="chat-header"><button type="button" className="chat-back-btn" aria-label="Back to conversations" onClick={() => setThreadOpen(false)}>←</button><div><h2>{displayIdentity(conversation)}</h2><small>{conversation.is_lid ? 'WhatsApp identity protected' : displayIdentity({ phone: conversation.phone })}{conversation.company ? ` · ${conversation.company}` : ''}</small></div><span className={`campaign-status ${conversation.status === 'human_takeover' ? 'stopped' : conversation.ai_enabled ? 'running' : 'paused'}`}>{conversation.status === 'human_takeover' ? 'Human attention required' : conversation.ai_enabled ? 'AI Active' : 'Human Active'}</span></div><div className="message-stream">{messages.map((item) => <article key={item.id} className={`chat-message ${item.direction === 'inbound' ? 'inbound' : 'outbound'}`}><small>{item.direction === 'inbound' ? 'Customer' : 'Sudarshan Pipes AI Assistant'}</small><p>{item.body}</p><time>{item.status}</time></article>)}</div>
{showCopilot && <CopilotPanel conversationId={selectedId} identity={conversation?.name} />}<div className="chat-controls"><button className="secondary-btn" onClick={toggleAI} disabled={busy}>{conversation.ai_enabled ? 'Pause AI' : 'Resume AI'}</button><button className="secondary-btn" onClick={takeOver} disabled={busy || conversation.status === 'human_takeover'}>Take Over</button><button className="secondary-btn" onClick={resolve} disabled={busy || conversation.status === 'resolved'}>Mark Resolved</button><button className="secondary-btn" onClick={() => setShowCopilot((open) => !open)}>{showCopilot ? 'Hide brief' : 'Copilot brief'}</button></div><form className="reply-form" onSubmit={sendReply}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a WhatsApp reply..." aria-label="WhatsApp reply" /><button className="primary-btn" disabled={busy || !draft.trim()}>Send Reply</button></form></> : <div className="empty-preview">Select a conversation to view its history.</div>}</section>
    </div>
  </div>
}

const formatDate = (value) => value ? new Date(value).toLocaleString() : 'Never'

function displayIdentity(contact) {
  if (contact?.name) return contact.name
  if (contact?.is_lid) return 'WhatsApp User'
  const digits = String(contact?.phone || '').replace(/[^\d]/g, '')
  if (digits.length >= 10) return `+${digits}`
  return contact?.phone || 'Unknown'
}

function PlaceholderPreview({ content }) {
  return <>{String(content || '').split(/(\{\{\w+\}\})/g).map((part, index) => part.match(/^\{\{\w+\}\}$/) ? <span className="placeholder" key={index}>{part}</span> : part)}</>
}

function ContactsView({ onNavigate }) {
  const [contacts, setContacts] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [stats, setStats] = useState({ total: 0, optedIn: 0, optedOut: 0 })
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState({ name: '', email: '', company: '', city: '', notes: '', tags: '', marketing_opt_in: false })
  const [deleteId, setDeleteId] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  // Inline "Add contact" form (empty-state CTA) — creating a contact manually
  // was previously impossible: the backend only created contacts via campaign
  // Excel uploads or incoming WhatsApp messages.
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState({ phone: '', name: '', company: '', marketing_opt_in: false })
  // Account-level default dial code (Settings → Default country code) shown
  // as a hint next to the phone field; the backend applies it on save.
  const [accountDefaultCode, setAccountDefaultCode] = useState('91')
  const limit = 50

  const load = async () => {
    try {
      const [data, nextStats] = await Promise.all([
        apiFetch(`/contacts?search=${encodeURIComponent(search)}&page=${page}&limit=${limit}`),
        apiFetch('/contacts/stats'),
      ])
      setContacts((data.data || []).map((contact) => ({ ...contact, name: displayIdentity(contact), phone: contact.is_lid ? '' : displayIdentity({ phone: contact.phone }) })))
      setTotal(data.total || 0)
      setStats(nextStats)
    } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) }
  }

  useEffect(() => { load() }, [search, page])

  useEffect(() => {
    apiFetch('/settings').then((settings) => { if (settings?.defaultCountryCode) setAccountDefaultCode(settings.defaultCountryCode) }).catch(() => {})
  }, [])

  const selectContact = (contact) => {
    setSelected(contact)
    setForm({ name: contact.name || '', email: contact.email || '', company: contact.company || '', city: contact.city || '', notes: contact.notes || '', tags: Array.isArray(contact.tags) ? contact.tags.join(', ') : contact.tags || '', marketing_opt_in: !!contact.marketing_opt_in })
    setDeleteId(null)
  }

  const createContact = async (event) => {
    event.preventDefault()
    if (!addForm.phone.trim()) return
    setBusy(true)
    try {
      const payload = { ...addForm, phone: addForm.phone.trim() }
      await saveWithConsentCheck((extra) => apiFetch('/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...extra }),
      }))
      setNotice({ type: 'success', text: 'Contact added.' })
      setAddForm({ phone: '', name: '', company: '', marketing_opt_in: false })
      setShowAddForm(false)
      await load()
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Contacts · add' }) })
    } finally { setBusy(false) }
  }

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    try {
      const body = { ...form, tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean) }
      await saveWithConsentCheck((extra) => apiFetch(`/contacts/${selected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }) }))
      setNotice({ type: 'success', text: 'Contact updated.' }); setSelected(null); await load()
    } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) }
  }

  const optOut = async (contact) => {
    setBusy(true)
    try { await apiFetch(`/contacts/${contact.id}/optout`, { method: 'POST' }); setNotice({ type: 'success', text: `${displayIdentity(contact)} opted out.` }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) }
  }

  const toggleContact = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllContacts = () => setSelectedIds(selectedIds.length === contacts.length ? [] : contacts.map((contact) => contact.id))
  const bulkDelete = async () => {
    if (!selectedIds.length || !window.confirm(`Delete ${selectedIds.length} selected contact(s)?`)) return
    setBusy(true)
    try { await apiFetch('/contacts/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setNotice({ type: 'success', text: `${selectedIds.length} contact(s) deleted.` }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) }
  }

  const remove = async (contact) => {
    if (deleteId !== contact.id) return setDeleteId(contact.id)
    setBusy(true)
    try { await apiFetch(`/contacts/${contact.id}`, { method: 'DELETE' }); setDeleteId(null); setSelected(null); setNotice({ type: 'success', text: 'Contact deleted.' }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) }
  }

  const pageCount = Math.max(1, Math.ceil(total / limit))
  return <div className="view-workspace">
    <div className="view-toolbar"><div><p className="eyebrow">Customer directory</p><h2>Contacts</h2><p className="muted-copy">Keep customer details, consent, and conversation context in one place.</p></div><div className="button-row"><input className="search-input" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Search contacts" /><button type="button" className="primary-btn" onClick={() => setShowAddForm((open) => !open)}>Add contact</button></div></div>
    {showAddForm && <section className="panel editor-panel"><div className="panel-header"><div><p className="eyebrow">New contact</p><h2>Add a contact manually</h2></div><button className="secondary-btn" onClick={() => setShowAddForm(false)}>Close</button></div><form className="form-grid" onSubmit={createContact}><label className="form-label">Phone number<input value={addForm.phone} onChange={(event) => setAddForm({ ...addForm, phone: event.target.value })} placeholder="98765 43210 or +44 7700 900123" required /><small>Numbers without a country code get your account default from Settings (currently +{accountDefaultCode}).</small></label><label className="form-label">Name<input value={addForm.name} onChange={(event) => setAddForm({ ...addForm, name: event.target.value })} placeholder="Customer name" /></label><label className="form-label">Company<input value={addForm.company} onChange={(event) => setAddForm({ ...addForm, company: event.target.value })} placeholder="Company (optional)" /></label><label className="check-label full-field"><input type="checkbox" checked={addForm.marketing_opt_in} onChange={(event) => setAddForm({ ...addForm, marketing_opt_in: event.target.checked })} /> Marketing opt-in</label><div className="button-row full-field"><button className="primary-btn" disabled={busy || !addForm.phone.trim()}>Save contact</button></div></form></section>}
    {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    <div className="stats-grid compact-stats">{[['Total contacts', stats.total, 'green'], ['Opted in', stats.optedIn, 'blue'], ['Opted out', stats.optedOut, 'amber']].map(([label, value, accent]) => <article className={`stat-card ${accent}`} key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
    {selected && <section className="panel editor-panel"><div className="panel-header"><div><p className="eyebrow">Editing contact</p><h2>{selected.name || selected.phone}</h2></div><button className="secondary-btn" onClick={() => setSelected(null)}>Close</button></div><CopilotPanel contactId={selected.id} identity={selected.name || selected.phone} /><form className="form-grid" onSubmit={save}><label className="form-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label className="form-label">Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="name@example.com" /><small>Optional — used for email campaigns.</small></label><label className="form-label">Company<input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></label><label className="form-label">City<input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></label><label className="form-label">Tags<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="dealer, priority" /></label><label className="form-label full-field">Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label className="check-label full-field"><input type="checkbox" checked={form.marketing_opt_in} onChange={(event) => setForm({ ...form, marketing_opt_in: event.target.checked })} /> Marketing opt-in</label><div className="button-row full-field"><button className="primary-btn" disabled={busy}>Save changes</button></div></form></section>}
    <section className="panel"><div className="panel-header"><h2>All contacts</h2><span className="file-note">{total} records</span></div>{selectedIds.length > 0 && <div className="button-row"><span>{selectedIds.length} selected</span><button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button></div>}<div className="campaign-table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all contacts on this page" checked={contacts.length > 0 && selectedIds.length === contacts.length} onChange={toggleAllContacts} /></th><th>Phone number</th><th>Name</th><th>Email</th><th>Company</th><th>City</th><th>Opt-in</th><th>Last message</th><th>Actions</th></tr></thead><tbody>{contacts.map((contact) => <tr key={contact.id} onClick={() => selectContact(contact)}><td data-label="Select" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${contact.name || contact.phone}`} checked={selectedIds.includes(contact.id)} onChange={() => toggleContact(contact.id)} /></td><td data-label="Phone">{contact.phone}</td><td data-label="Name">{contact.name || 'Unknown'}</td><td data-label="Email">{contact.email || '-'}</td><td data-label="Company">{contact.company || '-'}</td><td data-label="City">{contact.city || '-'}</td><td data-label="Consent"><span className={`campaign-status ${contact.marketing_opt_in ? 'running' : 'stopped'}`} title={consentTitle(contact)}>{contact.marketing_opt_in ? 'Opted in' : contact.opted_out_at ? 'Opted out' : 'No consent'}</span></td><td data-label="Last message">{formatDate(contact.last_message_at)}</td><td data-label="Actions"><div className="button-row" onClick={(event) => event.stopPropagation()}><button className="secondary-btn" onClick={() => optOut(contact)} disabled={busy || !contact.marketing_opt_in}>Opt out</button><button className="danger-btn" onClick={() => remove(contact)} disabled={busy}>{deleteId === contact.id ? 'Confirm delete' : 'Delete'}</button></div></td></tr>)}</tbody></table>{!contacts.length && (search
                ? <EmptyState icon="🔍" title="No matching contacts" description={`No contacts match “${search}”. Try a different name, phone number, or company.`} />
                : <EmptyState
                    icon="👥"
                    title="No contacts yet"
                    description="Add your first contact or upload an Excel file to get started."
                    actions={[
                      { label: 'Add contact', onClick: () => setShowAddForm(true) },
                      { label: 'Import from an Excel file', variant: 'secondary', onClick: () => (onNavigate || ((view) => { window.location.hash = `#${view}` }))('Campaigns') },
                    ]}
                  />)}</div><div className="pagination"><button className="secondary-btn" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>Previous</button><span>Page {page} of {pageCount}</span><button className="secondary-btn" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>Next</button></div></section>
  </div>
}

function TemplatesView() {
  const [templates, setTemplates] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [form, setForm] = useState({ name: '', content: '' })
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const load = async () => { try { setTemplates(await apiFetch('/templates')) } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } }
  useEffect(() => { load() }, [])
  const submit = async (event) => { event.preventDefault(); setBusy(true); try { await apiFetch(editing ? `/templates/${editing}` : '/templates', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }); setForm({ name: '', content: '' }); setEditing(null); setNotice({ type: 'success', text: editing ? 'Template updated.' : 'Template created.' }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) } }
  const duplicate = async (id) => { try { await apiFetch(`/templates/${id}/duplicate`, { method: 'POST' }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } }
  const remove = async (id) => { if (!window.confirm('Delete this template?')) return; try { await apiFetch(`/templates/${id}`, { method: 'DELETE' }); setSelectedIds((current) => current.filter((item) => item !== id)); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } }
  const bulkDelete = async () => { if (!selectedIds.length || !window.confirm(`Delete ${selectedIds.length} selected template(s)?`)) return; setBusy(true); try { await apiFetch('/templates/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setNotice({ type: 'success', text: `${selectedIds.length} template(s) deleted.` }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) } }
  const toggleTemplate = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllTemplates = () => setSelectedIds(selectedIds.length === templates.length ? [] : templates.map((template) => template.id))
  const loadExample = (exampleType) => {
    if (exampleType === 'inquiry') {
      setForm({ name: 'Product Inquiry Follow-up', content: `Hello {{name}} 👋\n\nThis is Sudarshan Pipes.\nWe wanted to know if {{company}} currently has any requirements for {{product}} in {{city}}.\n\nPlease let us know your required quantity and timeline.\n\nBest regards,\nSudarshan Pipes Team` })
    } else if (exampleType === 'reengagement') {
      setForm({ name: 'Re-engagement Offer', content: `Hi {{name}},\n\nIt's been a while since we last connected. We'd love to reconnect with {{company}}.\n\nWe've recently expanded our {{product}} range and would like to discuss how we can better serve your needs in {{city}}.\n\nWould you be interested in a quick call this week?\n\nBest regards,\nSudarshan Pipes Team` })
    } else if (exampleType === 'promotion') {
      setForm({ name: 'Promotional Announcement', content: `Hi {{name}},\n\nExciting news! Sudarshan Pipes is launching a special promotion on {{product}}.\n\nLimited time offer:\n• Competitive pricing\n• Fast delivery to {{city}}\n• Dedicated support for bulk orders\n\nReply with "More Info" to learn more, or reach out directly.\n\nSudarshan Pipes Team` })
    }
  }
  return <div className="view-workspace"><div><p className="eyebrow">Reusable messages</p><h2>Templates</h2><p className="muted-copy">Build consistent messages with fields that personalize at send time.</p></div>{notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}<div className="split-view"><section className="panel"><div className="panel-header"><h2>{editing ? 'Edit template' : 'New template'}</h2>{editing && <button className="secondary-btn" onClick={() => { setEditing(null); setForm({ name: '', content: '' }) }}>Cancel</button>}</div><form className="campaign-builder form-stack" onSubmit={submit}><label className="form-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label className="form-label">Content<textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} required /><small className="help-note">Fields like <code>{"{{name}}"}</code>, <code>{"{{company}}"}</code>, <code>{"{{product}}"}</code>, <code>{"{{city}}"}</code> are replaced with actual data from your Excel sheet. Example: <code>{"Hi {{name}}"}</code> becomes "Hi Rajesh" when name=Rajesh in your upload.</small></label><button className="primary-btn" disabled={busy}>{editing ? 'Update template' : 'Create template'}</button></form><div className="button-row"><button type="button" className="secondary-btn" onClick={() => loadExample('inquiry')} disabled={busy}>Load example: Product Inquiry</button><button type="button" className="secondary-btn" onClick={() => loadExample('reengagement')} disabled={busy}>Load example: Re-engagement</button><button type="button" className="secondary-btn" onClick={() => loadExample('promotion')} disabled={busy}>Load example: Promotion</button></div></section><section className="template-grid"><div className="panel-header"><span>{selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Select templates'}</span><div className="button-row"><label className="check-label"><input type="checkbox" aria-label="Select all templates" checked={templates.length > 0 && selectedIds.length === templates.length} onChange={toggleAllTemplates} /> All</label>{selectedIds.length > 0 && <button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button>}</div></div>{templates.map((template) => <article className="panel template-card" key={template.id}><div className="panel-header"><label className="check-label"><input type="checkbox" aria-label={`Select ${template.name}`} checked={selectedIds.includes(template.id)} onChange={() => toggleTemplate(template.id)} /> Select</label><small className="file-note">Updated {formatDate(template.updated_at)}</small></div><h2>{template.name}</h2><p className="template-preview"><PlaceholderPreview content={template.content} /></p><div className="button-row"><button className="secondary-btn" onClick={() => { setEditing(template.id); setForm({ name: template.name, content: template.content }) }}>Edit</button><button className="secondary-btn" onClick={() => duplicate(template.id)}>Duplicate</button><button className="danger-btn" onClick={() => remove(template.id)}>Delete</button></div></article>)}{!templates.length && <div className="panel"><EmptyState icon="📝" title="No templates yet" description={`Save time by creating reusable message templates — fields like {{name}} personalize every send automatically.`} actions={[{ label: 'Create your first template', onClick: () => document.querySelector('.campaign-builder input')?.focus() }] } /></div>}</section></div></div>
}

function KnowledgeBaseView() {
  const [documents, setDocuments] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [form, setForm] = useState({ name: '', category: 'general', content: '', internal_only: false })
  const [file, setFile] = useState(null)
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const load = async () => { try { setDocuments(await apiFetch('/knowledge')) } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } }
  useEffect(() => { load() }, [])
  const save = async (event) => { event.preventDefault(); setBusy(true); try { await apiFetch(editing ? `/knowledge/${editing}` : '/knowledge', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }); setForm({ name: '', category: 'general', content: '', internal_only: false }); setEditing(null); setNotice({ type: 'success', text: editing ? 'Document updated.' : 'Document added.' }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) } }
  const upload = async (event) => { event.preventDefault(); if (!file) return; setBusy(true); const formData = new FormData(); formData.append('file', file); formData.append('name', form.name); formData.append('category', form.category); formData.append('internal_only', form.internal_only ? 'true' : 'false'); try { await apiFetch('/knowledge/upload', { method: 'POST', body: formData }); setFile(null); setForm({ name: '', category: 'general', content: '', internal_only: false }); setNotice({ type: 'success', text: 'Document uploaded.' }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) } }
  const remove = async (id) => { if (!window.confirm('Delete this document?')) return; try { await apiFetch(`/knowledge/${id}`, { method: 'DELETE' }); setSelectedIds((current) => current.filter((item) => item !== id)); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } }
  const bulkDelete = async () => { if (!selectedIds.length || !window.confirm(`Delete ${selectedIds.length} selected document(s)?`)) return; setBusy(true); try { await apiFetch('/knowledge/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setNotice({ type: 'success', text: `${selectedIds.length} document(s) deleted.` }); await load() } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) } }
  const toggleDocument = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllDocuments = () => setSelectedIds(selectedIds.length === documents.length ? [] : documents.map((document) => document.id))
  const edit = async (id) => { try { const doc = await apiFetch(`/knowledge/${id}`); setEditing(id); setForm({ name: doc.name, category: doc.category, content: doc.content, internal_only: !!doc.internal_only }) } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } }
  const loadExample = (exampleType) => {
    if (exampleType === 'spec') {
      setForm({ name: 'UGD Pipe Specifications', category: 'Product Specs', content: `Diameter Range: 20mm to 110mm\nMaterial Grade: Grade B, Grade C, Grade D\nStandard Compliance: IS 651:2015 (uPVC pipes for water supply)\n\nTypical Use Cases:\n- Municipal water distribution networks\n- Agricultural irrigation systems\n- Industrial process water applications\n\nKey Performance Features:\n- Corrosion-resistant uPVC construction\n- Lightweight and easy to install\n- Hydrostatic strength rated for 10-16 bar working pressure\n- UV-stabilized for outdoor applications\n- Long service life of 50+ years with minimal maintenance` })
    } else if (exampleType === 'faq') {
      setForm({ name: 'UGD Pipes - Frequently Asked Questions', category: 'FAQ', content: `Q: What is the difference between Grade B and Grade C pipes?\nA: Grade C pipes have higher hydrostatic strength and are suitable for higher pressure applications. Grade B is standard for municipal water supply.\n\nQ: Can UGD pipes be used for hot water?\nA: No, uPVC pipes are designed for cold water applications only. Exposure to temperatures above 40°C may damage the pipes.\n\nQ: How long do UGD pipes last?\nA: With proper installation and maintenance, UGD pipes have a service life of 50 years or more.\n\nQ: Are UGD pipes environmentally friendly?\nA: Yes, uPVC is recyclable and the pipes don't leach harmful chemicals into water.` })
    }
  }
  return <div className="view-workspace"><div><p className="eyebrow">AI context library</p><h2>Knowledge Base</h2><p className="muted-copy">This content feeds the AI's replies through the knowledge base lookup.</p></div>{notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}<div className="split-view"><section className="panel"><div className="panel-header"><h2>{editing ? 'Edit document' : 'Add text'}</h2>{editing && <button className="secondary-btn" onClick={() => { setEditing(null); setForm({ name: '', category: 'general', content: '' }) }}>Cancel</button>}</div><form className="form-stack" onSubmit={save}><label className="form-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label className="form-label">Category<input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></label><label className="check-label"><input type="checkbox" checked={form.internal_only} onChange={(event) => setForm({ ...form, internal_only: event.target.checked })} /> Internal only <small>— keeps this document out of every customer WhatsApp auto-reply (staff procedures, internal pricing, notes).</small></label><label className="form-label">Content<textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} required /></label><div className="help-note"><strong>Tips for good entries:</strong> Be specific and factual. Keep one topic per entry. Avoid mixing unrelated products. Strong entries directly improve AI reply accuracy.</div><button className="primary-btn" disabled={busy}>{editing ? 'Update document' : 'Add document'}</button></form><div className="button-row"><button type="button" className="secondary-btn" onClick={() => loadExample('spec')} disabled={busy}>Load example: Product Specs</button><button type="button" className="secondary-btn" onClick={() => loadExample('faq')} disabled={busy}>Load example: FAQ</button></div><div className="upload-divider"><span>or upload a file</span></div><form className="form-stack" onSubmit={upload}><label className="upload-dropzone">{file ? file.name : 'Choose TXT, MD, PDF, or DOCX'}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label><button className="secondary-btn" disabled={busy || !file}>Upload document</button></form></section><section className="panel"><div className="panel-header"><h2>Documents</h2><span className="file-note">{documents.length} sources</span></div><div className="button-row"><label className="check-label"><input type="checkbox" aria-label="Select all knowledge documents" checked={documents.length > 0 && selectedIds.length === documents.length} onChange={toggleAllDocuments} /> All</label>{selectedIds.length > 0 && <><span>{selectedIds.length} selected</span><button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button></>}</div><div className="campaign-table-wrap"><table><thead><tr><th>Select</th><th>Name</th><th>Category</th><th>Status</th><th>Length</th><th>Added</th><th /></tr></thead><tbody>{documents.map((document) => <tr key={document.id}><td data-label="Select"><input type="checkbox" aria-label={`Select ${document.name}`} checked={selectedIds.includes(document.id)} onChange={() => toggleDocument(document.id)} /></td><td data-label="Name"><strong>{document.name}</strong>{document.internal_only && <span className="internal-badge" title="Internal only — excluded from customer WhatsApp auto-replies">Internal only</span>}</td><td data-label="Category">{document.category}</td><td data-label="Status"><span className={`campaign-status ${document.status === 'active' ? 'running' : 'paused'}`}>{document.status}</span></td><td data-label="Length">{document.content_length} chars</td><td data-label="Added">{formatDate(document.created_at)}</td><td data-label="Actions"><div className="button-row"><button className="secondary-btn" onClick={() => edit(document.id)}>Edit</button><button className="danger-btn" onClick={() => remove(document.id)}>Delete</button></div></td></tr>)}</tbody></table>{!documents.length && <EmptyState icon="📚" title="No documents yet" description="Upload files so the AI can answer questions using your business information — products, pricing, policies." actions={[{ label: 'Add or upload a document', onClick: () => document.querySelector('.form-stack input')?.focus() }] } />}</div></section></div></div>
}

function AnalyticsView({ onNavigate }) {
  const [dashboard, setDashboard] = useState(null)
  const [trend, setTrend] = useState([])
  const [notice, setNotice] = useState({ type: '', text: '' })
  useEffect(() => { Promise.all([apiFetch('/analytics/dashboard'), apiFetch('/analytics/messages/trend?days=7')]).then(([data, nextTrend]) => { setDashboard({ ...data, recentMessages: (data.recentMessages || []).map((message) => ({ ...message, name: displayIdentity(message) })) }); setTrend(nextTrend || []) }).catch((error) => setNotice({ type: 'error', text: friendlyErrorMessage(error) })) }, [])
  if (!dashboard) return <div className="view-workspace">{notice.text ? <div className="notice error">{notice.text}</div> : <SkeletonPanel label="Loading analytics" variant="dashboard" />}</div>
  const cards = [['Active contacts', dashboard.contacts.active, 'green'], ['Opted-out contacts', dashboard.contacts.optedOut, 'amber'], ['Open conversations', dashboard.conversations.open, 'blue'], ['Human takeover', dashboard.conversations.human_takeover, 'violet'], ['Resolved', dashboard.conversations.resolved, 'green'], ['Inbound messages', dashboard.messages.inbound, 'blue'], ['Outbound messages', dashboard.messages.outbound, 'violet'], ['Campaigns sent', dashboard.campaigns.total_sent, 'green'], ['Campaigns failed', dashboard.campaigns.total_failed, 'amber'], ['Campaign replies', dashboard.campaigns.total_replies, 'blue'], ['Campaign opt-outs', dashboard.campaigns.total_opt_outs, 'violet']]
  const maxValue = Math.max(1, ...trend.flatMap((item) => [item.inbound || 0, item.outbound || 0]))
  return <div className="view-workspace"><div><p className="eyebrow">Performance overview</p><h2>Analytics</h2><p className="muted-copy">A compact view of customer activity, campaigns, and message flow.</p></div>{notice.text && <div className="notice error">{notice.text}</div>}<div className="stats-grid analytics-stats">{cards.map(([label, value, accent]) => <article className={`stat-card ${accent}`} key={label}><span>{label}</span><strong>{value || 0}</strong></article>)}</div><div className="analytics-grid"><section className="panel"><div className="panel-header"><h2>Message trend</h2><span className="file-note">Last 7 days</span></div><div className="trend-chart">{trend.length ? trend.map((item) => <div className="trend-day" key={item.date}><div className="trend-bars"><i className="inbound-bar" style={{ height: `${Math.max(4, ((item.inbound || 0) / maxValue) * 100)}%` }} /><i className="outbound-bar" style={{ height: `${Math.max(4, ((item.outbound || 0) / maxValue) * 100)}%` }} /></div><small>{item.date.slice(5)}</small><span>{item.inbound || 0} / {item.outbound || 0}</span></div>) : <EmptyState icon="📊" title="No message activity yet" description="Once conversations and campaigns start exchanging messages, daily trends will appear here." />}</div><div className="chart-legend"><span><i className="inbound-bar" /> Inbound</span><span><i className="outbound-bar" /> Outbound</span></div></section><section className="panel"><div className="panel-header"><h2>Recent messages</h2></div><ul className="list recent-message-list">{dashboard.recentMessages.map((message, index) => <li key={`${message.created_at}-${index}`}><div><strong>{message.name || message.phone}</strong><small>{message.body}</small></div><span className={`campaign-status ${message.direction === 'inbound' ? 'running' : 'completed'}`}>{message.direction}</span></li>)}</ul>{!dashboard.recentMessages.length && <EmptyState icon="✉️" title="No messages yet" description="Inbound and outbound messages will appear here once customers start chatting with you." />}</section></div><section className="panel"><div className="panel-header"><h2>Recent campaigns</h2></div><div className="campaign-table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Sent</th><th>Failed</th><th>Replies</th><th>Opt-outs</th></tr></thead><tbody>{dashboard.recentCampaigns.map((campaign) => <tr key={campaign.id}><td data-label="Campaign"><strong>{campaign.name}</strong><small>{formatDate(campaign.created_at)}</small></td><td data-label="Status"><span className={`campaign-status ${String(campaign.status).toLowerCase()}`}>{campaign.status}</span></td><td data-label="Sent">{campaign.sent}</td><td data-label="Failed">{campaign.failed}</td><td data-label="Replies">{campaign.replies}</td><td data-label="Opt-outs">{campaign.opt_outs}</td></tr>)}</tbody></table>{!dashboard.recentCampaigns.length && <EmptyState icon="📣" title="No campaign activity yet" description="Create and run your first campaign — its delivery and reply stats will show up here." actions={[{ label: 'Go to Campaigns', onClick: () => (onNavigate || ((view) => { window.location.hash = `#${view}` }))('Campaigns') }] } />}</div></section></div>
}

function SettingsView({ userEmail }) {
  const [settings, setSettings] = useState(null)
  const [form, setForm] = useState({ aiApiKey: '', aiBaseURL: '', aiModel: '', businessName: '', businessTagline: '', companyAddress: '', companyState: '', companyGstin: '', companyPhone: '', companyEmail: '', companyLogo: '', companyBankDetails: '', resendApiKey: '', resendFromEmail: '', resendFromName: '', defaultCountryCode: '91' })
  const [showKey, setShowKey] = useState(false)
  const [showResendKey, setShowResendKey] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [testNotice, setTestNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  useEffect(() => { apiFetch('/settings').then(setSettings).catch((error) => setNotice({ type: 'error', text: friendlyErrorMessage(error) })) }, [])
  useEffect(() => { if (settings) setForm((current) => ({ ...current, aiBaseURL: settings.ai.baseURL, aiModel: settings.ai.model, businessName: settings.business.name, businessTagline: settings.business.tagline, companyAddress: settings.business.address || '', companyState: settings.business.state || '', companyGstin: settings.business.gstin || '', companyPhone: settings.business.phone || '', companyEmail: settings.business.email || '', companyLogo: settings.business.logo || '', companyBankDetails: settings.business.bankDetails || '', defaultCountryCode: settings.defaultCountryCode || '91', resendFromEmail: settings.email?.fromEmail || '', resendFromName: settings.email?.fromName || '' })) }, [settings])
  const save = async (event) => { event.preventDefault(); setBusy(true); const payload = Object.fromEntries(Object.entries(form).filter(([, value]) => value.trim())); try { const updated = await apiFetch('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); setSettings(updated); setForm((current) => ({ ...current, aiApiKey: '', resendApiKey: '', aiBaseURL: updated.ai.baseURL, aiModel: updated.ai.model, businessName: updated.business.name, businessTagline: updated.business.tagline, companyAddress: updated.business.address || '', companyState: updated.business.state || '', companyGstin: updated.business.gstin || '', companyPhone: updated.business.phone || '', companyEmail: updated.business.email || '', companyLogo: updated.business.logo || '', companyBankDetails: updated.business.bankDetails || '', defaultCountryCode: updated.defaultCountryCode || current.defaultCountryCode, resendFromEmail: updated.email?.fromEmail || '', resendFromName: updated.email?.fromName || '' })); setShowKey(false); setShowResendKey(false); setNotice({ type: 'success', text: 'Settings saved.' }) } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error) }) } finally { setBusy(false) } }
  const testResend = async () => {
    setTesting(true); setTestNotice({ type: '', text: '' })
    try {
      const result = await apiFetch('/settings/email/test', { method: 'POST' })
      setTestNotice({ type: 'success', text: result.message || `Test email sent to ${userEmail}. Check your inbox (and spam folder).` })
    } catch (error) {
      // Resend setup errors stay actionable/specific — the backend already
      // phrases them for users ("Resend rejected the test email: …"). The
      // translator keeps them but strips any embedded technical detail
      // (stack traces, JSON objects, status-code strings).
      setTestNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Resend test email' }) })
    } finally { setTesting(false) }
  }
  if (!settings) return <div className="view-workspace">{notice.text ? <div className="notice error">{notice.text}</div> : <SkeletonPanel label="Loading settings" />}</div>
  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value })
  return <div className="view-workspace">
    <div><p className="eyebrow">Server configuration</p><h2>Settings</h2><p className="muted-copy">Update your AI connection, email sender, business details, quotation company profile, and default country code.</p></div>
    {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    <section className="panel settings-panel appearance-panel">
      <div className="panel-header"><div><h2>Appearance</h2><p className="muted-copy">Choose light or dark. "Match my device" follows your phone or computer setting. This is saved on this device only.</p></div></div>
      <ThemeChoice withSystem label="Appearance" />
    </section>
    <form onSubmit={save}>
      <section className="panel settings-panel">
        <div className="panel-header"><h2>AI assistant</h2><span className={`campaign-status ${settings.ai.available ? 'running' : 'stopped'}`}>{settings.ai.available ? 'Available' : 'Unavailable'}</span></div>
        <div className="settings-grid">
          <label className="form-label">API key<div className="input-with-action"><input type={showKey ? 'text' : 'password'} value={form.aiApiKey} onChange={update('aiApiKey')} placeholder="Leave blank to keep current key" autoComplete="new-password" /><button type="button" className="secondary-btn" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button></div><small>Leave blank to keep the saved key.</small></label>
          <label className="form-label">Base URL<input value={form.aiBaseURL} onChange={update('aiBaseURL')} /></label>
          <label className="form-label">Model<input value={form.aiModel} onChange={update('aiModel')} /></label>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-header"><h2>Email (Resend)</h2><span className={`campaign-status ${settings.email?.configured ? 'running' : 'stopped'}`}>{settings.email?.configured ? 'Configured' : 'Not configured'}</span></div>
        <div className="settings-grid">
          <label className="form-label">API key<div className="input-with-action"><input type={showResendKey ? 'text' : 'password'} value={form.resendApiKey} onChange={update('resendApiKey')} placeholder={settings.email?.apiKeySet ? 'Leave blank to keep current key' : 're_...'} autoComplete="new-password" /><button type="button" className="secondary-btn" onClick={() => setShowResendKey(!showResendKey)}>{showResendKey ? 'Hide' : 'Show'}</button></div><small>Leave blank to keep the saved key.</small></label>
          <label className="form-label">From email<input value={form.resendFromEmail} onChange={update('resendFromEmail')} placeholder="hello@yourdomain.com" /></label>
          <label className="form-label">From name<input value={form.resendFromName} onChange={update('resendFromName')} placeholder="Your Business Name" /></label>
        </div>
        {testNotice.text && <div className={`notice ${testNotice.type} settings-test-notice`}>{testNotice.text}</div>}
        <div className="button-row"><button type="button" className="secondary-btn" onClick={testResend} disabled={testing || busy}>{testing ? 'Sending test email...' : 'Test Connection'}</button><small className="help-note">Sends one test email to {userEmail || 'your account email'} using the saved credentials.</small></div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-header"><h2>Business information</h2></div>
        <div className="settings-grid">
          <label className="form-label">Business name<input value={form.businessName} onChange={update('businessName')} /></label>
          <label className="form-label">Tagline<input value={form.businessTagline} onChange={update('businessTagline')} /></label>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-header"><h2>Quotation company profile</h2></div>
        <div className="settings-grid">
          <label className="form-label">Company address<textarea value={form.companyAddress} onChange={update('companyAddress')} /></label>
          <label className="form-label">Company state<input value={form.companyState} onChange={update('companyState')} /><small>Used to split GST into CGST/SGST for same-state customers; otherwise IGST is shown.</small></label>
          <label className="form-label">Company GSTIN<input value={form.companyGstin} onChange={update('companyGstin')} /></label>
          <label className="form-label">Company phone<input value={form.companyPhone} onChange={update('companyPhone')} /></label>
          <label className="form-label">Company email<input value={form.companyEmail} onChange={update('companyEmail')} /></label>
          <label className="form-label">Logo data URL<input value={form.companyLogo} onChange={update('companyLogo')} placeholder="data:image/png;base64,..." /><small>Optional PNG/JPEG data URL used on exported quotations.</small></label>
          <label className="form-label">Bank details<textarea value={form.companyBankDetails} onChange={update('companyBankDetails')} /></label>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-header"><h2>Default country code</h2></div>
        <div className="settings-grid"><label className="form-label">Default country code<select value={form.defaultCountryCode} onChange={update('defaultCountryCode')} className="country-select">{(settings.countries || COUNTRIES).map((country) => <option key={`${country.name}-${country.dialCode}`} value={country.dialCode}>{country.name} (+{country.dialCode})</option>)}</select></label></div>
      </section>
      <div className="button-row"><button className="primary-btn" disabled={busy}>{busy ? 'Saving...' : 'Save settings'}</button></div>
    </form>
  </div>
}

function App() {
  const [session, setSession] = useState(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [resetPasswordMode, setResetPasswordMode] = useState(false)
  const [activeView, setActiveView] = useState('Dashboard')
  // "BOQ & quotations" stays mounted (hidden) once opened, so an upload in
  // progress, the open BOQ, unsaved edits and the open quotation survive a
  // tab change. boqActivity drives the sidebar badge ('reading' | 'ready').
  const [boqKept, setBoqKept] = useState(false)
  const [boqActivity, setBoqActivity] = useState(null)
  if (activeView === 'Document Intelligence' && !boqKept) setBoqKept(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [backendStatus, setBackendStatus] = useState('Checking...')
  const [isConnected, setIsConnected] = useState(false)
  // Display only: lets the status chip show a connected Business API.
  const [businessApiStatus, setBusinessApiStatus] = useState('')
  const [dashboard, setDashboard] = useState(null)
  const [recentConversations, setRecentConversations] = useState(null)
  const [dashboardError, setDashboardError] = useState('')
  // Shared workspaces: { self, active, sharedAccess, shared: [{ id, email }] }
  const [workspaces, setWorkspaces] = useState(null)
  // Desktop sidebar collapsed to an icon rail (remembered per browser).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed' } catch { return false }
  })
  const [greeting] = useState(greetingNow)
  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current
      try { window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? 'collapsed' : 'expanded') } catch { /* storage unavailable */ }
      return next
    })
  }

  // ── Minimal hash-based routing ────────────────────────────────────────
  // ''          → public landing page (default for logged-out visitors)
  // '#/login'   → sign-in / sign-up flow (WelcomeAuthPage)
  // '#/app'     → authenticated app shell (also the post-login default)
  // Any other hash falls back to the landing page for logged-out users.
  const readRoute = () => {
    const hash = window.location.hash.replace(/^#/, '')
    if (hash === '/login' || hash === '/app') return hash
    return ''
  }
  const [route, setRoute] = useState(readRoute)

  const navigate = (nextRoute) => {
    // Central navigation: updates the hash (which triggers the listener
    // below) or sets state directly when the hash is already correct.
    if (window.location.hash !== `#${nextRoute}`) {
      window.location.hash = nextRoute
    } else {
      setRoute(nextRoute)
    }
    window.scrollTo(0, 0)
  }

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setAuthChecking(false)
      return
    }

    // Detect initial session (handles page refresh, OAuth callback, recovery link)
    // The OAuth callback URL contains tokens in the hash fragment:
    // /auth/callback#access_token=...&refresh_token=...&expires_at=...
    // Supabase's detectSessionInUrl: true handles parsing these automatically.
    supabase.auth.getSession().then(({ data: { session } }) => {
      console.log('[initial getSession]', !!session, session?.user?.email)
      setSession(session)
      setAuthChecking(false)
    }).catch(() => {
      setAuthChecking(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[auth event]', event, !!session, session?.user?.email)
      if (event === 'PASSWORD_RECOVERY') {
        // Supabase has exchanged the recovery token — show reset-password UI
        setResetPasswordMode(true)
        setSession(session)
        setAuthChecking(false)
        return
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setResetPasswordMode(false)
      }
      if (event === 'SIGNED_OUT') {
        setResetPasswordMode(false)
      }
      setSession(session)
      setAuthChecking(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  // Clean up OAuth token fragments from the URL after a callback (they would
  // otherwise linger in the address bar and be bookmarkable/shared).
  // Route hashes (#/login, #/app) are left untouched — they drive the
  // hash-based routing, so wiping every hash would break refresh-deep-links.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (hash && (hash.includes('access_token') || hash.includes('refresh_token') || hash.includes('error') || hash.includes('code='))) {
      // Clear the hash without triggering a page reload or a hashchange event
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  // Explicit Sign Out ONLY — never called on tab close, refresh, or
  // network drop. Tells the backend to fully log out this user's own
  // WhatsApp session (real Baileys logout + delete stored auth state)
  // BEFORE the local sign-out. If this call fails (e.g. network drop
  // mid-signout), the local sign-out still completes — it never blocks.
  //
  // ORDER MATTERS (BUG 1): the backend call MUST fire while the access
  // token is still valid. If the stored session is already dead (expired
  // token whose refresh was rejected, e.g. after the tab slept past the
  // token lifetime), apiFetch would send no/invalid Authorization header
  // and the backend would 401 without ever invalidating the WhatsApp
  // session. In that case we clear the dead local session first so
  // supabase.auth.signOut() works from a clean state.
  const handleSignOut = async () => {
    // Snapshot the token FIRST — nothing below can invalidate it before
    // the backend call carries it.
    let accessToken = null
    if (supabase) {
      try {
        const { data } = await supabase.auth.getSession()
        accessToken = data?.session?.access_token || null
      } catch (error) {
        console.warn('[signout] getSession failed while snapshotting token:', error?.message)
      }
    }

    setWorkspaces(null)
    if (supabase && !accessToken) {
      // Session already dead/expired locally — the backend call would be a
      // guaranteed 401 (it still gets one if a race happens; harmless).
      console.warn('[signout] no usable access token — skipping backend WhatsApp logout (already dead)')
      try { await supabase.auth._removeSession() } catch { /* best effort */ }
    } else {
      try {
        // Always the signed-in user's own WhatsApp — never a shared owner's.
        await apiFetch('/whatsapp/logout', { method: 'POST', headers: { [DATA_OWNER_HEADER]: '' } })
        console.log('[signout] backend WhatsApp logout completed while token was still valid')
      } catch (error) {
        console.error('Backend WhatsApp logout failed (continuing sign-out):', error)
        // A 401 here means the token died between the snapshot and the call.
        // apiFetch already cleared the dead local session in that case.
      }
    }

    // ONLY NOW the local sign-out. NOTE: if the WhatsApp-logout 401 was a
    // symptom of an already-dead session, the following signOut() 403 on
    // /auth/v1/logout?scope=global is expected (global revoke needs a valid
    // JWT) — auth-js still clears local storage, so sign-out completes.
    if (supabase) {
      try {
        await supabase.auth.signOut()
      } catch (error) {
        // Never let a failed remote revoke block local sign-out.
        console.error('[signout] supabase signOut failed (local session cleared anyway):', error)
        try { await supabase.auth._removeSession() } catch { /* best effort */ }
      }
    }
    setSession(null)
    // Drop the just-cleared session out of the component state that
    // polling effects read, so their in-flight tick exits early.
    setBackendStatus('offline')
    setIsConnected(false)
    // Return to the sign-in route (not the public landing page) — the user
    // was already authenticated, so the marketing page would be noise.
    navigate('/login')
  }

  const selectView = (item) => {
    setActiveView(item)
    setDrawerOpen(false)
    if (item === 'Document Intelligence' && boqActivity && boqActivity !== 'reading') setBoqActivity(null)
  }

  // Lock background scrolling while the mobile navigation drawer is open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  useEffect(() => {
    // Per-user WhatsApp status: uses the authenticated endpoint, so the
    // pill reflects THIS user's connection only — not anyone else's.
    // Guard + deps on session: stops the interval entirely on sign-out
    // instead of polling with a dead token (BUG 2).
    if (!session) return

    const loadStatus = async () => {
      if (!session) return
      try {
        const data = await apiFetch('/whatsapp/status')
        setBackendStatus(data.status || 'disconnected')
        setIsConnected(data.status === 'connected')
        setBusinessApiStatus(data.businessStatus || '')
      } catch {
        setBackendStatus('offline')
        setIsConnected(false)
      }
    }

    loadStatus()
    const interval = window.setInterval(loadStatus, 10000)
    return () => window.clearInterval(interval)
  }, [session?.user?.id])

  useEffect(() => {
    // Dashboard polling. Deps on session: on sign-out the effect re-runs,
    // clears the old interval, and the guard below stops re-arming it.
    if (!session) return

    const loadDashboard = async () => {
      try {
        const [nextDashboard, conversationData] = await Promise.all([
          apiFetch('/analytics/dashboard'),
          apiFetch('/conversations?limit=5'),
        ])
        setDashboard(nextDashboard)
        setRecentConversations(conversationData.data || [])
        setDashboardError('')
      } catch (error) {
        setDashboardError(friendlyErrorMessage(error, { context: 'Dashboard' }))
      }
    }

    loadDashboard()
    const interval = window.setInterval(loadDashboard, 10000)
    return () => window.clearInterval(interval)
  }, [session?.user?.id])

  // Last-resort safety net (BUG 2): if the session becomes null while a
  // polling loop is still executing (async race), stop it on the next tick
  // instead of issuing authenticated requests that can only 401.
  useEffect(() => {
    if (session || authChecking) return
    dispatchSessionInvalidated('session cleared')
  }, [session?.user?.id, authChecking])

  const statusClassOf = (status) => `campaign-status ${String(status || '').toLowerCase().replaceAll('_', '-')}`

  // Dashboard: only numbers the dashboard API already returns. Rings show
  // ratios between those numbers (never invented values).
  const renderDashboard = () => {
    if (!dashboard || !recentConversations) {
      return dashboardError
        ? <div className="notice error" role="alert">{dashboardError}</div>
        : <SkeletonPanel label="Loading your dashboard…" variant="dashboard" />
    }
    const totals = dashboard.campaigns || {}
    const sent = Number(totals.total_sent) || 0
    const failed = Number(totals.total_failed) || 0
    const attempted = sent + failed
    const kpis = [
      { label: 'Messages sent', value: sent, accent: 'green', icon: 'send', ring: percentOf(sent, attempted), note: 'of attempted messages went out' },
      ...(totals.total_delivered != null ? [{ label: 'Delivered', value: Number(totals.total_delivered) || 0, accent: 'blue', icon: 'check-circle', ring: percentOf(totals.total_delivered, sent), note: 'of sent messages were delivered' }] : []),
      ...(totals.total_read != null ? [{ label: 'Read', value: Number(totals.total_read) || 0, accent: 'violet', icon: 'eye', ring: percentOf(totals.total_read, sent), note: 'of sent messages were read' }] : []),
      { label: 'Failed', value: failed, accent: 'amber', icon: 'alert', ring: percentOf(failed, attempted), note: 'of attempted messages failed' },
      { label: 'Opted out', value: Number(totals.total_opt_outs) || 0, accent: 'violet', icon: 'ban', ring: percentOf(totals.total_opt_outs, sent), note: 'of messaged contacts opted out' },
      { label: 'Replies', value: Number(totals.total_replies) || 0, accent: 'blue', icon: 'reply', ring: percentOf(totals.total_replies, sent), note: 'of messaged contacts replied' },
    ]
    const glance = [
      { label: 'Contacts', value: dashboard.contacts?.total, icon: 'users' },
      { label: 'Open conversations', value: dashboard.conversations?.open, icon: 'chat' },
      { label: 'Messages received', value: dashboard.messages?.inbound, icon: 'inbox' },
      { label: 'Campaigns sending', value: totals.active, icon: 'megaphone' },
    ]
    const liveCampaigns = (dashboard.recentCampaigns || []).filter((campaign) => ['running', 'paused', 'queued'].includes(campaign.status))
    return (
      <div className="dashboard">
        {/* New-account setup guide: step completion derives from live
            data (WhatsApp status + analytics poll below + knowledge doc
            count) and hides itself once dismissed or fully complete. */}
        <OnboardingChecklist onNavigate={setActiveView} dashboard={dashboard} whatsappConnected={isConnected} />

        <section className="kpi-grid" aria-label="Campaign results">
          {kpis.map((kpi) => (
            <article key={kpi.label} className={`stat-card kpi-tile ${kpi.accent}`}>
              <div className="kpi-head"><span className="kpi-icon" aria-hidden="true"><Icon name={kpi.icon} size={17} /></span><span className="kpi-label">{kpi.label}</span></div>
              <div className="kpi-body">
                <strong>{kpi.value.toLocaleString('en-IN')}</strong>
                {kpi.ring === null
                  ? <span className="kpi-ring-empty" aria-hidden="true">—</span>
                  : <span className="kpi-ring-wrap"><ProgressRing value={kpi.ring} label={`${kpi.ring}% ${kpi.note}`} /><span className="kpi-ring-text" aria-hidden="true">{kpi.ring}%</span></span>}
              </div>
              <p className="kpi-note">{kpi.ring === null ? 'No campaign messages yet' : `${kpi.ring}% ${kpi.note}`}</p>
            </article>
          ))}
        </section>

        <div className="dashboard-grid">
          <section className="panel queue-status-card" aria-live="polite">
            <div className="panel-header">
              <div><p className="eyebrow">Live · updates every 10 s</p><h2>Campaign queue</h2></div>
              <span className={`campaign-status ${Number(totals.active) > 0 ? 'running' : 'draft'}`}>{Number(totals.active) > 0 ? `${totals.active} sending` : 'Idle'}</span>
            </div>
            {liveCampaigns.length ? (
              <ul className="queue-list">
                {liveCampaigns.map((campaign) => {
                  const pct = percentOf(campaign.sent, campaign.total_contacts) ?? 0
                  return (
                    <li key={campaign.id}>
                      <div className="queue-item-head"><strong>{campaign.name}</strong><span className={statusClassOf(campaign.status)}>{campaign.status.replaceAll('_', ' ')}</span></div>
                      <div className={`campaign-progress${campaign.status === 'running' ? ' is-live' : ''}`} role="progressbar" aria-label={`${campaign.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
                      <small className="tabular">{(campaign.sent || 0).toLocaleString('en-IN')} of {(campaign.total_contacts || 0).toLocaleString('en-IN')} sent{campaign.failed ? ` · ${campaign.failed} failed` : ''}</small>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <EmptyState icon="layers" title="Nothing is sending right now" description="Running, paused and queued campaigns show here with their progress." actions={[{ label: 'Open campaigns', onClick: () => setActiveView('Campaigns') }]} />
            )}
          </section>

          <section className="panel glance-card">
            <div className="panel-header"><div><p className="eyebrow">At a glance</p><h2>Your workspace</h2></div><ConnectionChip status={chipStatus} onClick={() => setActiveView('WhatsApp Connection')} /></div>
            <ul className="glance-list">
              {glance.map((item) => (
                <li key={item.label}><span className="glance-icon" aria-hidden="true"><Icon name={item.icon} size={18} /></span><span className="glance-label">{item.label}</span><strong className="mono">{Number(item.value || 0).toLocaleString('en-IN')}</strong></li>
              ))}
            </ul>
          </section>
        </div>

        <div className="dashboard-grid">
          <article className="panel">
            <div className="panel-header">
              <h2>Recent campaigns</h2>
              <button type="button" className="ghost-btn" onClick={() => setActiveView('Campaigns')}>View all <Icon name="chevron-right" size={16} /></button>
            </div>
            <ul className="list activity-list">
              {dashboard.recentCampaigns.map((campaign) => (
                <li key={campaign.id}>
                  <span className="activity-icon" aria-hidden="true"><Icon name="megaphone" size={16} /></span>
                  <div className="activity-text">
                    <strong>{campaign.name}</strong>
                    <small className="tabular">{campaign.sent || 0} / {campaign.total_contacts || 0} sent</small>
                  </div>
                  <span className={statusClassOf(campaign.status)}>{String(campaign.status).replaceAll('_', ' ')}</span>
                </li>
              ))}
            </ul>
            {!dashboard.recentCampaigns.length && (
              <EmptyState
                icon="📣"
                title="No campaigns yet"
                description="Create your first campaign to start reaching customers with personalized messages."
                actions={[{ label: 'Create campaign', onClick: () => setActiveView('Campaigns') }]}
              />
            )}
          </article>

          <article className="panel">
            <div className="panel-header">
              <h2>Recent conversations</h2>
              <button type="button" className="ghost-btn" onClick={() => setActiveView('Inbox')}>Open inbox <Icon name="chevron-right" size={16} /></button>
            </div>
            <ul className="list conversation-list activity-list">
              {recentConversations.map((conversation) => (
                <li key={conversation.id}>
                  <span className="activity-icon" aria-hidden="true"><Icon name="chat" size={16} /></span>
                  <div className="activity-text">
                    <strong>{displayIdentity(conversation)}</strong>
                    <small>{conversation.last_message || 'No messages yet'}</small>
                  </div>
                  <span className={`tag ${conversation.status === 'human_takeover' ? '' : 'muted'}`}>{conversation.status === 'human_takeover' ? 'Needs you' : conversation.ai_enabled ? 'AI replying' : 'You are replying'}</span>
                </li>
              ))}
            </ul>
            {!recentConversations.length && (
              <EmptyState
                icon="💬"
                title="No conversations yet"
                description="Once customers message your connected WhatsApp number, their conversations will appear here."
                actions={[{ label: 'Check connection', variant: 'secondary', onClick: () => setActiveView('WhatsApp Connection') }]}
              />
            )}
          </article>
        </div>

        <section className="panel message-editor cta-card">
          <div className="cta-copy"><p className="eyebrow">Next step</p><h2>Start a campaign</h2><p className="muted-copy">Upload an Excel list, write one message with personal fields, and send it safely from the queue.</p></div>
          <button type="button" className="primary-btn" onClick={() => setActiveView('Campaigns')}><Icon name="plus" size={18} /> New campaign</button>
        </section>
      </div>
    )
  }

  const renderView = () => {
    if (activeView === 'WhatsApp Connection') return <ConnectionView />
    if (activeView === 'Campaigns') return <CampaignsView onNavigate={setActiveView} />
    if (activeView === 'Inbox') return <InboxView onNavigate={setActiveView} />
    if (activeView === 'Contacts') return <ContactsView onNavigate={setActiveView} />
    if (activeView === 'Templates') return <TemplatesView />
    if (activeView === 'Knowledge Base') return <KnowledgeBaseView />
    if (activeView === 'Ask AI') return <AskAiView />
    if (activeView === 'Document Intelligence') return null // kept mounted below
    if (activeView === 'Analytics') return <AnalyticsView onNavigate={setActiveView} />
    if (activeView === 'Settings') return <SettingsView userEmail={session?.user?.email} />
    if (activeView === 'Image Extractor') return <ImageExtractorView />
    if (activeView === 'Dashboard') return renderDashboard()

    return (
      <section className="panel empty-state-panel">
        <h2>{activeView}</h2>
        <p className="muted-copy">This section is ready for the next feature slice.</p>
        <button type="button" className="primary-btn" onClick={() => setActiveView('Dashboard')}>
          Back to dashboard
        </button>
      </section>
    )
  }

  // Keep the hash route in sync with auth state: a signed-in user always
  // lands in the app shell, whatever route they arrived on — this covers
  // direct sign-in (onAuthSuccess) and OAuth redirects back to '/', where
  // the session arrives via onAuthStateChange instead of onAuthSuccess.
  useEffect(() => {
    if (session && route !== '/app') navigate('/app')  }, [session?.user?.id, route])

  // Load the workspaces shared with this user. On first sign-in with a
  // shared workspace (and no remembered choice) open the shared data, which
  // is why the share exists; the switcher can go back to the user's own data.
  useEffect(() => {
    const authUserId = session?.user?.id
    if (!authUserId) return
    let cancelled = false
    apiFetch('/workspaces')
      .then((data) => {
        if (cancelled) return
        if (!hasStoredDataOwnerChoice(authUserId) && data?.shared?.length) {
          setStoredDataOwner(authUserId, data.shared[0].id, { silent: true })
          window.location.reload()
          return
        }
        setWorkspaces(data)
      })
      .catch((error) => { if (!cancelled) console.warn('[workspaces] could not load shared workspaces:', error?.message) })
    return () => { cancelled = true }
  }, [session?.user?.id])

  // Switching workspace (or a revoked share) reloads so every view, poll
  // and socket starts cleanly against the newly selected data.
  useEffect(() => {
    const onWorkspaceChanged = () => window.location.reload()
    window.addEventListener(WORKSPACE_CHANGED_EVENT, onWorkspaceChanged)
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, onWorkspaceChanged)
  }, [])

  const chipStatus = backendStatus !== 'connected' && businessApiStatus === 'connected' ? 'business_connected' : backendStatus
  const activeSharedWorkspace = workspaces?.sharedAccess ? workspaces.shared?.find((item) => item.id === workspaces.active) : null
  const workspaceSwitcher = workspaces?.shared?.length ? (
    <label className="workspace-switcher">
      <span>Workspace</span>
      <select
        value={workspaces.active}
        onChange={(event) => setStoredDataOwner(session?.user?.id, event.target.value)}
        aria-label="Choose whose data to work with"
      >
        <option value={workspaces.self.id}>My data ({workspaces.self.email || 'you'})</option>
        {workspaces.shared.map((item) => <option key={item.id} value={item.id}>Shared: {item.email || item.id}</option>)}
      </select>
    </label>
  ) : null

  if (authChecking) {
    return (
      <div className="app-splash" role="status" aria-live="polite">
        <BrandLogo height={46} />
        <span className="app-splash-spinner" aria-hidden="true" />
        <p>Loading Sudarshan Pipes AI Assistant…</p>
      </div>
    )
  }

  if (!session || resetPasswordMode) {
    // Logged out: the public landing page is the default route; the sign-in /
    // sign-up flow lives at #/login. PASSWORD_RECOVERY always forces the auth
    // page regardless of the current hash. A logged-in visitor who lands on
    // the landing page is bounced to /login by LandingPage's session check.
    if (route === '/login' || resetPasswordMode) {
      return (
        <WelcomeAuthPage
          onAuthSuccess={(newSession) => { setSession(newSession); setResetPasswordMode(false); navigate('/app') }}
          initialMode={resetPasswordMode ? 'reset-password' : undefined}
        />
      )
    }
    return <LandingPage onSignIn={() => navigate('/login')} />
  }

  const userEmail = session?.user?.email || ''
  const pageTitle = activeView === 'Dashboard' ? 'Dashboard' : navLabel(activeView)
  const pageEyebrow = activeView === 'Dashboard' ? greeting : navGroupOf(activeView)

  return (
    <div className={`app-shell${drawerOpen ? ' drawer-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <header className="mobile-topbar">
        <button type="button" className="hamburger-btn" aria-label="Open navigation menu" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
          <Icon name="menu" />
        </button>
        <span className="mobile-brand"><BrandLogo variant="mark" height={26} decorative /><span className="mobile-brand-title">Sudarshan Pipes AI</span></span>
        <ConnectionChip status={chipStatus} onClick={() => selectView('WhatsApp Connection')} />
        <ThemeToggle />
      </header>
      <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
      <aside className="sidebar" aria-label="Sidebar">
        <button type="button" className="icon-btn drawer-close" aria-label="Close navigation menu" onClick={() => setDrawerOpen(false)}><Icon name="close" /></button>
        <div className="sidebar-brand">
          <div className="sidebar-brand-text brand-full">
            <BrandLogo height={34} />
            <span className="sidebar-product">AI Assistant</span>
          </div>
          <span className="brand-mark-only"><BrandLogo variant="mark" height={32} /></span>
          <button type="button" className="icon-btn collapse-btn" onClick={toggleSidebar} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <Icon name={sidebarCollapsed ? 'sidebar-expand' : 'sidebar-collapse'} />
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Primary Navigation">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.title}>
              <p className="nav-group-title">{group.title}</p>
              {group.items.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={item === activeView ? 'nav-item active' : 'nav-item'}
                  aria-current={item === activeView ? 'page' : undefined}
                  onClick={() => selectView(item)}
                  title={navLabel(item)}
                >
                  <Icon name={NAV_META[item]?.icon} />
                  <span className="nav-label">{navLabel(item)}</span>
                  {item === 'Document Intelligence' && boqActivity && (
                    <span className={`nav-badge is-${boqActivity}`} role="status">
                      <span className="nav-badge-dot" aria-hidden="true" />
                      <span className="nav-badge-text">{{ reading: 'Reading…', ready: 'Ready', failed: 'Needs a look' }[boqActivity]}</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          {workspaceSwitcher}
          <ConnectionChip status={chipStatus} block onClick={() => selectView('WhatsApp Connection')} />
          <div className="user-chip" title={userEmail}>
            <span className="user-avatar" aria-hidden="true">{(userEmail || 'U').charAt(0)}</span>
            <span className="user-chip-text"><strong>Signed in</strong><span className="user-chip-email">{userEmail || 'Logged in'}</span></span>
          </div>
          <button type="button" onClick={handleSignOut} className="sign-out-btn" title={userEmail ? `Sign out ${userEmail}` : 'Sign out'}>
            <Icon name="logout" size={16} />
            <span className="sign-out-label">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="content-wrapper">
        <header className="topbar">
          <div className="topbar-title">
            <p className="eyebrow">{pageEyebrow}</p>
            <h1>{pageTitle}</h1>
          </div>
          <div className="topbar-actions">
            <ThemeChoice />
          </div>
        </header>

        <main className="main-panel" id="main-content">
          <div className="page">
            {activeSharedWorkspace && <div className="notice info shared-workspace-notice" role="status">
              You are working in <strong>{activeSharedWorkspace.email || 'a shared'}</strong>'s workspace (shared with you). Records you add or change here belong to that workspace. Settings and the WhatsApp connection can only be changed by its owner.
            </div>}

            {boqKept && (
              <div className="kept-view" hidden={activeView !== 'Document Intelligence'}>
                <DocumentIntelView active={activeView === 'Document Intelligence'} onActivity={setBoqActivity} />
              </div>
            )}
            {renderView()}
          </div>
          <footer className="page-footer">© {CURRENT_YEAR} Sudarshan Pipes &amp; Fittings · AI Assistant</footer>
        </main>
      </div>
    </div>
  )
}

export default App
