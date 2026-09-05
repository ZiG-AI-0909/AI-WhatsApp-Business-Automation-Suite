import { useEffect, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import ImageExtractorView from './ImageExtractorView.jsx'

const API_URL = 'http://localhost:3000/api'

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...(options.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data
}

const navItems = [
  'Dashboard',
  'WhatsApp Connection',
  'Inbox',
  'Campaigns',
  'Contacts',
  'Templates',
  'Knowledge Base',
  'Analytics',
  'Settings',
  'Image Extractor',
]

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
    <section className="lead-queue"><div className="panel-header"><div><p className="eyebrow">Your lead queue</p><h2>Who should you speak to next?</h2><p className="muted-copy">Each reason is based on a real activity, so you know why this is the right next step.</p></div></div><div className="lead-filters">{[['all','All leads'],['hot','Hot'],['warm','Warm'],['cold','Cold']].map(([key,label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="lead-list">{leads.map((lead) => <article className="lead-card" key={lead.id}><div className="lead-card-main"><div className="lead-card-title"><span className={`priority-badge ${lead.priority}`}>{lead.priority === 'hot' ? 'Hot lead — likely ready to buy' : lead.priority === 'warm' ? 'Warm lead — keep the conversation going' : 'Cold lead — needs a gentle reminder'}</span><span className="score-detail">Score {lead.score}/100</span></div><div className="lead-identity"><div><h3>{lead.name}</h3><p>{lead.company} · {lead.phone}</p></div><SourceMarker source={lead.source} /></div><p className="lead-reason"><strong>Why now:</strong> {lead.reason}</p></div><button className="primary-btn" onClick={() => openComposer(lead)}>{lead.action}</button></article>)}</div></section>
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

const defaultTemplate = `Hello {{name}} 👋\n\nThis is Bhavesh Pipes.\nWe wanted to know if {{company}} currently has any requirements for {{product}} in {{city}}.\n\nPlease let us know your required quantity.`

function CampaignsView() {
  const [campaignList, setCampaignList] = useState([])
  const [schedules, setSchedules] = useState([])
  const [selectedScheduleIds, setSelectedScheduleIds] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [selectedCampaign, setSelectedCampaign] = useState(null)
  const [file, setFile] = useState(null)
  const [mediaFile, setMediaFile] = useState(null)
  const [mediaPath, setMediaPath] = useState('')
  const [mediaType, setMediaType] = useState('')
  const [mediaFilename, setMediaFilename] = useState('')
  const [mediaMimetype, setMediaMimetype] = useState('')
  const [mediaPreview, setMediaPreview] = useState('')
  const [buttons, setButtons] = useState([])
  const [upload, setUpload] = useState(null)
  const [template, setTemplate] = useState(defaultTemplate)
  const [name, setName] = useState('')
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
  const [waitingHoursMessage, setWaitingHoursMessage] = useState('')

  const loadCampaigns = async () => {
    try {
      const data = await apiFetch('/campaigns?limit=50')
      setCampaignList(data.data || [])
      if (selectedCampaign) {
        const current = (data.data || []).find((item) => item.id === selectedCampaign.id)
        if (current) setSelectedCampaign(current)
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message })
    }
  }

  const loadSchedules = async () => {
    try { setSchedules(await apiFetch('/schedules')) } catch (error) { setMessage({ type: 'error', text: error.message }) }
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
    const socket = io('http://localhost:3000', { transports: ['websocket', 'polling'] })
    
    // Handle schedule:failed events
    const scheduleFailed = (event) => { setMessage({ type: 'error', text: `Schedule "${event.name}" failed: ${event.error}` }); loadSchedules() }
    socket.on('schedule:failed', scheduleFailed)
    
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
    
    // Handle campaign:waiting_hours — surface inline message for demo visibility
    const campaignWaitingHours = (event) => {
      setSelectedCampaign((current) => {
        if (current?.id === event.campaignId) {
          setWaitingHoursMessage('Waiting for business hours to resume sending')
        }
        return current
      })
    }
    socket.on('campaign:waiting_hours', campaignWaitingHours)
    
    // Clear waiting message when campaign starts sending again
    const clearWaitingOnStatusChange = () => {
      setWaitingHoursMessage('')
    }
    socket.on('campaign:started', clearWaitingOnStatusChange)
    socket.on('campaign:resumed', clearWaitingOnStatusChange)
    
    return () => {
      socket.off('schedule:failed', scheduleFailed)
      socket.off('campaign:progress', campaignProgress)
      socket.off('campaign:started', campaignStatusChange)
      socket.off('campaign:paused', campaignStatusChange)
      socket.off('campaign:resumed', campaignStatusChange)
      socket.off('campaign:stopped', campaignStatusChange)
      socket.off('campaign:completed', campaignStatusChange)
      socket.off('campaign:error', campaignStatusChange)
      socket.off('campaign:waiting_hours', campaignWaitingHours)
      socket.off('campaign:started', clearWaitingOnStatusChange)
      socket.off('campaign:resumed', clearWaitingOnStatusChange)
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

  useEffect(() => {
    if (!selectedCampaign) { setCampaignContacts([]); return }
    apiFetch(`/campaigns/${selectedCampaign.id}/contacts?limit=100`).then((data) => setCampaignContacts(data.data || [])).catch(() => setCampaignContacts([]))
  }, [selectedCampaign?.id, selectedCampaign?.processed])

  const uploadExcel = async (event) => {
    const nextFile = event.target.files?.[0]
    if (!nextFile) return
    setFile(nextFile)
    setUpload(null)
    setPreviews([])
    setMissingByField({})
    setMessage({ type: '', text: '' })
    const formData = new FormData()
    formData.append('file', nextFile)
    setBusy(true)
    try {
      const data = await apiFetch('/campaigns/validate-excel', { method: 'POST', body: formData })
      setUpload(data)
      setMessage({ type: 'success', text: `${data.valid} valid contacts ready.` })
    } catch (error) {
      setMessage({ type: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  const uploadMedia = async (event) => {
    const nextFile = event.target.files?.[0]
    if (!nextFile) return
    setMediaFile(nextFile)
    setMediaPreview(URL.createObjectURL(nextFile))
    setMediaPath('')
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
      setMediaType(data.mediaType)
      setMediaFilename(data.filename)
      setMediaMimetype(data.mimetype)
      const isImage = data.mediaType === 'image'
      setMessage({ type: 'success', text: `Campaign ${isImage ? 'image' : 'document'} uploaded.` })
    } catch (error) {
      setMediaFile(null)
      setMediaPreview('')
      setMessage({ type: 'error', text: error.message })
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
      setMessage({ type: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  const createCampaign = async (event) => {
    event.preventDefault()
    if (!upload?.filePath) return setMessage({ type: 'error', text: 'Upload a valid XLSX file first.' })
    setBusy(true)
    try {
      const buttonsPayload = whatsappStatus.provider === 'WhatsApp Business API' ? buttons : []
      const settingsPayload = { delayBetweenMessages: 17500, retryCount: 2, retryDelay: 30000 }
      if (scheduleType !== 'now') {
        if (scheduleType === 'once' && (!runAt || new Date(runAt) <= new Date())) throw new Error('Choose a future date and time.')
        const recurrenceCron = scheduleType === 'recurring' ? (recurrenceMode === 'custom' ? customCron.trim() : (() => { const [hour, minute] = scheduleTime.split(':'); if (recurrenceMode === 'weekly') return `${minute} ${hour} * * ${scheduleWeekday}`; if (recurrenceMode === 'monthly') return `${minute} ${hour} ${scheduleMonthDay} * *`; return `${minute} ${hour} * * *` })()) : undefined
        await apiFetch('/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, templateMessage: template, filePath: upload.filePath, mediaPath: mediaPath || undefined, mediaType: mediaType || undefined, mediaFilename: mediaFilename || undefined, mediaMimetype: mediaMimetype || undefined, buttons: buttonsPayload, allowMissingFields, settings: settingsPayload, scheduleType, runAt: scheduleType === 'once' ? new Date(runAt).toISOString() : undefined, recurrenceCron }) })
        setMessage({ type: 'success', text: scheduleType === 'once' ? 'Campaign scheduled.' : 'Recurring campaign schedule created.' })
        await loadSchedules()
      } else {
        const campaign = await apiFetch('/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, templateMessage: template, filePath: upload.filePath, mediaPath: mediaPath || undefined, mediaType: mediaType || undefined, mediaFilename: mediaFilename || undefined, mediaMimetype: mediaMimetype || undefined, buttons: buttonsPayload, allowMissingFields, settings: settingsPayload }),
        })
        setSelectedCampaign(campaign)
        setMessage({ type: 'success', text: `Campaign created with ${campaign.total_contacts} queued contacts.` })
        await loadCampaigns()
      }
      setName('')
      setFile(null)
      setUpload(null)
      setMediaFile(null)
      setMediaPath('')
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
      setMessage({ type: 'error', text: error.message })
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
      setMessage({ type: 'error', text: error.message })
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
    try { await apiFetch('/campaigns/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setSelectedCampaign(null); setMessage({ type: 'success', text: `${selectedIds.length} campaign(s) deleted.` }); await loadCampaigns() } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const scheduleAction = async (id, action, method = 'PATCH') => {
    try { await apiFetch(`/schedules/${id}${action ? `/${action}` : ''}`, { method }); await loadSchedules() } catch (error) { setMessage({ type: 'error', text: error.message }) }
  }
  const retrySchedule = async (id) => { await scheduleAction(id, 'retry') }
  const deleteSchedule = async (id) => { if (!window.confirm('Delete this schedule?')) return; await scheduleAction(id, '', 'DELETE') }
  const toggleSchedule = (id) => setSelectedScheduleIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllSchedules = () => setSelectedScheduleIds(selectedScheduleIds.length === schedules.length ? [] : schedules.map((schedule) => schedule.id))
  const bulkDeleteSchedules = async () => { if (!selectedScheduleIds.length || !window.confirm(`Delete ${selectedScheduleIds.length} selected schedule(s)?`)) return; try { await apiFetch('/schedules/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedScheduleIds }) }); setSelectedScheduleIds([]); await loadSchedules() } catch (error) { setMessage({ type: 'error', text: error.message }) } }

  const statusClass = (status) => `campaign-status ${String(status || '').toLowerCase()}`

  return (
    <div className="campaign-workspace">
      <div className="campaign-toolbar">
        <div>
          <p className="eyebrow">Excel to WhatsApp</p>
          <h2>Campaign manager</h2>
          <p className="muted-copy">Upload contacts, personalize every row, then send from a persistent queue.</p>
        </div>
          <label className="primary-btn upload-btn">
          {busy ? 'Working...' : 'Choose XLSX file'}
          <input type="file" accept=".xlsx" onChange={uploadExcel} disabled={busy} />
        </label>
      </div>

      {message.text && <div className={`notice ${message.type}`}>{message.text}</div>}

      <div className="campaign-layout">
        <section className="panel campaign-builder">
          <div className="panel-header"><h2>1. Build campaign</h2><span className="file-note">{file?.name || 'No file selected'}</span></div>
          <form onSubmit={createCampaign}>
            {(whatsappStatus.provider === 'WhatsApp Web' || whatsappStatus.provider === 'web') && <div className="notice warning">Sending via WhatsApp Web carries a real risk of your number being banned for bulk sends. For business-critical campaigns, connect the WhatsApp Business API instead. <button type="button" onClick={() => setActiveView('WhatsApp Connection')}>Open Connection</button></div>}
            <label className="form-label">Campaign name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Dealer outreach - August" required /></label>
            <label className="form-label">Send timing<select value={scheduleType} onChange={(event) => setScheduleType(event.target.value)}><option value="now">Now</option><option value="once">Schedule once</option><option value="recurring">Recurring</option></select></label>
            {scheduleType === 'once' && <label className="form-label">Run at<input type="datetime-local" value={runAt} min={new Date(Date.now() + 60000).toISOString().slice(0, 16)} onChange={(event) => setRunAt(event.target.value)} required /></label>}
            {scheduleType === 'recurring' && <div className="field-panel inline-fields"><label className="form-label">Recurrence<select value={recurrenceMode} onChange={(event) => setRecurrenceMode(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="custom">Custom cron expression</option></select></label>{recurrenceMode !== 'custom' && <label className="form-label">Time<input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} /></label>}{recurrenceMode === 'weekly' && <label className="form-label">Day<select value={scheduleWeekday} onChange={(event) => setScheduleWeekday(event.target.value)}><option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option></select></label>}{recurrenceMode === 'monthly' && <label className="form-label">Day of month<input type="number" min="1" max="28" value={scheduleMonthDay} onChange={(event) => setScheduleMonthDay(event.target.value)} /></label>}{recurrenceMode === 'custom' && <label className="form-label">Cron expression<input value={customCron} onChange={(event) => setCustomCron(event.target.value)} placeholder="*/2 * * * *" required /></label>}<small className="muted-copy">Cron: {recurrenceMode === 'custom' ? customCron || 'Enter a cron expression' : (() => { const [hour, minute] = scheduleTime.split(':'); if (recurrenceMode === 'weekly') return `${minute} ${hour} * * ${scheduleWeekday}`; if (recurrenceMode === 'monthly') return `${minute} ${hour} ${scheduleMonthDay} * *`; return `${minute} ${hour} * * *` })()}</small></div>}
            <label className="form-label">Message template<textarea value={template} onChange={(event) => setTemplate(event.target.value)} required /></label>
            <div className="field-panel inline-fields">
              <h3>Detected fields</h3>
              {upload?.dynamicFields?.length ? <div className="field-list">{upload.dynamicFields.map((field) => <button key={field} type="button" className="field-chip" onClick={() => setTemplate((current) => `${current} {{${field}}}`)}>{`{{${field}}}`}</button>)}</div> : <small>Upload an XLSX file to detect every header automatically.</small>}
            </div>
            <div className="field-panel inline-fields">
              <div className="panel-header"><h3>Campaign media</h3><label className="secondary-btn upload-btn">{mediaFile ? 'Replace file' : 'Choose file'}<input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx" onChange={uploadMedia} disabled={busy} /></label></div>
              {mediaPreview && mediaType === 'image' ? <img className="media-thumb" src={mediaPreview} alt="Campaign preview" /> : mediaPreview && mediaType === 'document' ? <div className="media-document-preview"><div>📄</div><small>{mediaFilename}</small></div> : <small>Optional image (JPG, PNG, WEBP) or document (PDF, DOC, DOCX, XLS, XLSX), up to 16 MB.</small>}
            </div>
            <div className="field-panel inline-fields">
              {whatsappStatus.provider === 'WhatsApp Business API' ? <>
                <div className="panel-header"><h3>Buttons (Business API only)</h3>{buttons.length < 3 && <button type="button" className="secondary-btn" onClick={() => setButtons([...buttons, { type: 'quick_reply', text: '', url: '' }])}>Add button</button>}</div>
                {buttons.map((button, index) => <div className="button-config" key={index}><select value={button.type} onChange={(event) => setButtons(buttons.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item))}><option value="quick_reply">Quick Reply</option><option value="url">URL</option></select><input value={button.text} onChange={(event) => setButtons(buttons.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} placeholder="Button text" />{button.type === 'url' && <input value={button.url} onChange={(event) => setButtons(buttons.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item))} placeholder="https://example.com" />}<button type="button" className="danger-btn" onClick={() => setButtons(buttons.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></div>)}
                <small>Buttons only send on the WhatsApp Business API provider — ignored when sending via WhatsApp Web.</small>
              </> : <>
                <div className="panel-header"><h3>Buttons (Business API only)</h3></div>
                <small>Connect WhatsApp Business API to use buttons</small>
              </>}
            </div>
            {upload && <div className="validation-summary"><strong>{upload.valid} valid</strong><span>{upload.invalid} invalid</span><span>{upload.duplicates} duplicates</span><span>Phone column: {upload.phoneColumn}</span></div>}
            {Object.entries(missingByField).filter(([, count]) => count > 0).map(([field, count]) => <div className="missing-warning" key={field}>Warning: {count} contacts have no value for {`{{${field}}}`}. Creating this campaign requires explicit approval.</div>)}
            {Object.values(missingByField).some((count) => count > 0) && <label className="check-label"><input type="checkbox" checked={allowMissingFields} onChange={(event) => setAllowMissingFields(event.target.checked)} /> Allow unresolved fields to remain in messages</label>}
            {(whatsappStatus.provider === 'WhatsApp Web' || whatsappStatus.provider === 'web') && Number(upload?.valid || 0) > 200 && <div className="notice warning">This campaign contains more than 200 contacts and carries increased WhatsApp Web ban risk. Consider using the WhatsApp Business API.</div>}
            <div className="button-row"><button type="button" className="secondary-btn" onClick={previewMessages} disabled={!upload || busy}>Preview messages</button><button className="primary-btn" disabled={!upload || !name.trim() || busy}>Create persistent queue</button></div>
          </form>
        </section>

        <section className="panel preview-panel">
          <div className="panel-header"><h2>2. Preview</h2><span className="file-note">First 5 valid rows</span></div>
          {previews.length ? <div className="preview-list">{mediaPreview && <img className="preview-media" src={mediaPreview} alt="Campaign image preview" />}{previews.map((item) => <article key={item.phone} className="message-preview"><strong>{item.name || item.phone}</strong><small>{item.phone}</small><p>{item.rendered}</p>{item.missingFields.length > 0 && <em>Missing: {item.missingFields.join(', ')}</em>}</article>)}</div> : <div className="empty-preview">Upload a file and preview the rendered message before creating the queue.</div>}
        </section>
      </div>

      <section className="panel queue-panel">
        <div className="panel-header"><div><h2>Persistent campaign queue</h2><span className="file-note">{campaignList.length} campaigns</span></div>{selectedCampaign && <div className="button-row"><button className="secondary-btn" onClick={() => controlCampaign('start')} disabled={busy || !['draft', 'paused', 'stopped'].includes(selectedCampaign.status)}>Start</button><button className="secondary-btn" onClick={() => controlCampaign('pause')} disabled={busy || selectedCampaign.status !== 'running'}>Pause</button><button className="secondary-btn" onClick={() => controlCampaign('resume')} disabled={busy || selectedCampaign.status !== 'paused'}>Resume</button><button className="danger-btn" onClick={() => controlCampaign('stop')} disabled={busy || !['running', 'paused'].includes(selectedCampaign.status)}>Stop</button></div>}</div>
        {selectedIds.length > 0 && <div className="button-row"><span>{selectedIds.length} selected</span><button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button></div>}<div className="campaign-table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all campaigns on this page" checked={campaignList.length > 0 && selectedIds.length === campaignList.length} onChange={toggleAllCampaigns} /></th><th>Campaign</th><th>Provider</th><th>Status</th><th>Progress</th><th>Sent</th><th>Failed</th></tr></thead><tbody>{campaignList.map((campaign) => <tr key={campaign.id} className={selectedCampaign?.id === campaign.id ? 'selected-row' : ''} onClick={() => setSelectedCampaign(campaign)}><td onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${campaign.name}`} checked={selectedIds.includes(campaign.id)} onChange={() => toggleCampaign(campaign.id)} /></td><td><strong>{campaign.name}</strong><small>Created {campaign.created_at}</small></td><td>{campaign.provider || 'web'}</td><td><span className={statusClass(campaign.status)}>{campaign.status}</span></td><td>{campaign.processed} / {campaign.total_contacts}</td><td>{campaign.sent}</td><td>{campaign.failed}</td></tr>)}</tbody></table>{!campaignList.length && <div className="empty-preview">No campaigns created yet.</div>}</div>
        {selectedCampaign && <div className="campaign-detail"><div className="panel-header"><div><h3>{selectedCampaign.name}</h3><span className="file-note">Sending through: {selectedCampaign.provider || 'web'}</span></div><strong>{selectedCampaign.processed} / {selectedCampaign.total_contacts} processed</strong></div>{waitingHoursMessage && <div className="notice warning" style={{margin: '1rem 0'}}>{waitingHoursMessage}</div>}<p className="detail-template">{selectedCampaign.template_message}</p><div className="campaign-table-wrap"><table><thead><tr><th>Contact</th><th>Phone</th><th>Result</th><th>Error</th></tr></thead><tbody>{campaignContacts.map((contact) => <tr key={contact.id}><td>{contact.name || 'Unknown'}</td><td>{contact.phone}</td><td><span className={statusClass(contact.status)}>{contact.status}</span></td><td>{contact.last_error || ''}</td></tr>)}</tbody></table></div></div>}
      </section>
      <section className="panel queue-panel"><div className="panel-header"><div><h2>Scheduled campaigns</h2><span className="file-note">{schedules.length} schedules</span></div></div>{selectedScheduleIds.length > 0 && <div className="button-row"><span>{selectedScheduleIds.length} selected</span><button className="danger-btn" onClick={bulkDeleteSchedules}>Delete selected</button></div>}<div className="campaign-table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all schedules" checked={schedules.length > 0 && selectedScheduleIds.length === schedules.length} onChange={toggleAllSchedules} /></th><th>Name</th><th>Type</th><th>Next run</th><th>Status</th><th>Last run</th><th>Actions</th></tr></thead><tbody>{schedules.map((schedule) => <tr key={schedule.id} title={schedule.last_error || undefined}><td><input type="checkbox" aria-label={`Select ${schedule.name}`} checked={selectedScheduleIds.includes(schedule.id)} onChange={() => toggleSchedule(schedule.id)} /></td><td><strong>{schedule.name}</strong>{schedule.last_error && <small className="schedule-error">{schedule.last_error}</small>}</td><td>{schedule.schedule_type}</td><td>{formatDate(schedule.next_run_at)}</td><td><span className={statusClass(schedule.status)}>{schedule.status}</span></td><td>{formatDate(schedule.last_run_at)}</td><td><div className="button-row">{schedule.status === 'failed' && <button className="secondary-btn" onClick={() => retrySchedule(schedule.id)}>Retry now</button>}{['active', 'pending'].includes(schedule.status) && <button className="secondary-btn" onClick={() => scheduleAction(schedule.id, 'pause')}>Pause</button>}{schedule.status === 'paused' && <button className="secondary-btn" onClick={() => scheduleAction(schedule.id, 'resume')}>Resume</button>}{!['cancelled', 'completed', 'failed'].includes(schedule.status) && <button className="danger-btn" onClick={() => scheduleAction(schedule.id, 'cancel', 'POST')}>Cancel</button>}<button className="danger-btn" onClick={() => deleteSchedule(schedule.id)}>Delete</button></div></td></tr>)}</tbody></table>{!schedules.length && <div className="empty-preview">No scheduled campaigns yet.</div>}</div></section>
    </div>
  )
}

function ConnectionView() {
  const [status, setStatus] = useState({ provider: '', status: 'checking', qrAvailable: false })
  const [qr, setQr] = useState('')
  const [credentials, setCredentials] = useState({ phoneNumberId: '', accessToken: '', verifyToken: '' })
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)

  const loadStatus = async () => {
    try {
      const nextStatus = await apiFetch('/whatsapp/status')
      setStatus(nextStatus)
      if (nextStatus.qrAvailable && !qr) {
        const qrResponse = await apiFetch('/whatsapp/qr')
        setQr(qrResponse.qrDataUrl)
      } else if (!nextStatus.qrAvailable) {
        setQr('')
      }
    } catch (error) { setNotice({ type: 'error', text: error.message }) }
  }

  useEffect(() => {
    loadStatus()
    const interval = window.setInterval(loadStatus, 4000)
    return () => window.clearInterval(interval)
  }, [])

  const connectWeb = async () => {
    setBusy(true)
    try { await apiFetch('/whatsapp/provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'web' }) }); await apiFetch('/whatsapp/reconnect', { method: 'POST' }); setNotice({ type: 'success', text: 'WhatsApp Web is reconnecting. Scan the QR code when it appears.' }); await loadStatus() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const loadQr = async () => {
    try {
      const response = await apiFetch('/whatsapp/qr')
      setQr(response.qrDataUrl)
    } catch (error) {
      if (error.message === 'No QR code available') {
        try {
          await apiFetch('/whatsapp/reconnect', { method: 'POST' })
          setNotice({ type: 'success', text: 'Generating a fresh QR code. Please wait a few seconds.' })
          return
        } catch (reconnectError) {
          setNotice({ type: 'error', text: reconnectError.message })
          return
        }
      }
      setNotice({ type: 'error', text: error.message })
    }
  }

  const testBusiness = async () => {
    setBusy(true)
    try { await apiFetch('/whatsapp/business/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }); setNotice({ type: 'success', text: 'Business API credentials are valid.' }) } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const connectBusiness = async () => {
    setBusy(true)
    try { await apiFetch('/whatsapp/business/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }); setNotice({ type: 'success', text: 'WhatsApp Business API connected.' }); await loadStatus() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const disconnect = async () => {
    setBusy(true)
    try { await apiFetch('/whatsapp/disconnect', { method: 'POST' }); setNotice({ type: 'success', text: 'WhatsApp disconnected.' }); await loadStatus() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  return <div className="connection-workspace">
    <div><p className="eyebrow">One active connection</p><h2>Connect WhatsApp</h2><p className="muted-copy">Choose the provider used by the inbox, AI assistant, and campaigns.</p></div>
    {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    <div className="connection-grid">
      <section className="panel connection-card"><div className="connection-heading"><span className="connection-icon">&#128241;</span><div><h2>WhatsApp Web</h2><p className="muted-copy">Connect by scanning a QR code from your phone.</p></div></div><ol><li>Open WhatsApp on your phone</li><li>Go to Linked Devices</li><li>Choose Link a Device and scan</li></ol>{qr ? <img className="qr-image" src={qr} alt="WhatsApp Web QR code" /> : <div className="qr-placeholder">{status.qrAvailable ? 'QR code available' : 'No QR code available'}</div>}<div className="connection-actions"><button className="primary-btn" onClick={connectWeb} disabled={busy}>Connect with QR</button><button className="secondary-btn" onClick={loadQr} disabled={busy || !status.qrAvailable}>Refresh QR</button></div></section>
      <section className="panel connection-card"><div className="connection-heading"><span className="connection-icon">&#9729;</span><div><h2>WhatsApp Business API</h2><p className="muted-copy">Use Meta's official Cloud API connection.</p></div></div><label className="form-label">Phone Number ID<input value={credentials.phoneNumberId} onChange={(event) => setCredentials({ ...credentials, phoneNumberId: event.target.value })} /></label><label className="form-label">Access Token<input type="password" value={credentials.accessToken} onChange={(event) => setCredentials({ ...credentials, accessToken: event.target.value })} /></label><label className="form-label">Webhook Verify Token<input type="password" value={credentials.verifyToken} onChange={(event) => setCredentials({ ...credentials, verifyToken: event.target.value })} /></label><div className="connection-actions"><button className="secondary-btn" onClick={testBusiness} disabled={busy}>Test Connection</button><button className="primary-btn" onClick={connectBusiness} disabled={busy}>Connect Business API</button></div></section>
    </div>
    <section className="panel active-connection"><div><p className="eyebrow">Current provider</p><h2>{status.provider || 'Loading...'}</h2><p className="muted-copy">Status: <strong>{status.status}</strong></p></div><button className="danger-btn" onClick={disconnect} disabled={busy || status.status === 'disconnected'}>Disconnect</button></section>
  </div>
}

function InboxView() {
  const [conversations, setConversations] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const loadConversations = async () => {
    try {
      const data = await apiFetch(`/conversations?limit=50&search=${encodeURIComponent(search)}`)
      setConversations((data.data || []).map((item) => ({ ...item, name: displayIdentity(item) })))
      if (!selectedId && data.data?.[0]) setSelectedId(data.data[0].id)
    } catch (error) { setNotice(error.message) }
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
    } catch (error) { setNotice(error.message) }
  }

  useEffect(() => {
    loadConversations()
    const socket = io('http://localhost:3000', { transports: ['websocket', 'polling'] })
    const refresh = () => { loadConversations(); loadSelected() }
    const aiError = (event) => setNotice(event.error || 'AI provider unavailable. Check the AI configuration.')
    socket.on('message:new', refresh)
    socket.on('conversation:human_takeover', refresh)
    socket.on('conversation:ai_error', aiError)
    const interval = window.setInterval(refresh, 10000)
    return () => { socket.off('conversation:ai_error', aiError); socket.disconnect(); window.clearInterval(interval) }
  }, [search, selectedId])

  useEffect(() => { loadSelected() }, [selectedId])

  const updateConversation = async (path, options) => {
    setBusy(true)
    try { await apiFetch(path, options); await loadSelected(); await loadConversations() } catch (error) { setNotice(error.message) } finally { setBusy(false) }
  }

  const removeConversation = async (id) => {
    if (!window.confirm('Delete this conversation and its messages?')) return
    setBusy(true)
    try { await apiFetch(`/conversations/${id}`, { method: 'DELETE' }); if (selectedId === id) { setSelectedId(null); setConversation(null); setMessages([]) } await loadConversations(); setNotice('Conversation deleted.') } catch (error) { setNotice(error.message) } finally { setBusy(false) }
  }

  const sendReply = async (event) => {
    event.preventDefault()
    if (!draft.trim() || !selectedId) return
    setBusy(true)
    try { await apiFetch(`/conversations/${selectedId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: draft.trim() }) }); setDraft(''); await loadSelected(); await loadConversations() } catch (error) { setNotice(error.message) } finally { setBusy(false) }
  }

  const toggleAI = () => updateConversation(`/conversations/${selectedId}/ai`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !conversation?.ai_enabled }) })
  const takeOver = () => updateConversation(`/conversations/${selectedId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'human_takeover' }) })
  const resolve = () => updateConversation(`/conversations/${selectedId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) })

  return <div className="inbox-workspace">
    <div className="inbox-toolbar"><div><p className="eyebrow">Live conversations</p><h2>Inbox</h2></div><input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" /></div>
    {notice && <div className="notice error">{notice}</div>}
    <div className="inbox-layout">
      <aside className="panel conversation-sidebar"><h2>Conversations</h2>{conversations.map((item) => <div className="conversation-row" key={item.id}><button type="button" className={`conversation-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)}><span className="conversation-item-top"><strong>{displayIdentity(item)}</strong>{item.unread_count > 0 && <b>{item.unread_count}</b>}</span><small>{item.last_message || 'No messages yet'}</small>{item.status === 'human_takeover' && <em>Human attention required</em>}</button><button type="button" className="danger-btn" onClick={() => removeConversation(item.id)} disabled={busy}>Delete</button></div>)}{!conversations.length && <div className="empty-preview">No conversations yet.</div>}</aside>
      <section className="panel chat-panel">{conversation ? <><div className="chat-header"><div><h2>{displayIdentity(conversation)}</h2><small>{conversation.is_lid ? 'WhatsApp identity protected' : displayIdentity({ phone: conversation.phone })}{conversation.company ? ` · ${conversation.company}` : ''}</small></div><span className={`campaign-status ${conversation.status === 'human_takeover' ? 'stopped' : conversation.ai_enabled ? 'running' : 'paused'}`}>{conversation.status === 'human_takeover' ? 'Human attention required' : conversation.ai_enabled ? 'AI Active' : 'Human Active'}</span></div><div className="message-stream">{messages.map((item) => <article key={item.id} className={`chat-message ${item.direction === 'inbound' ? 'inbound' : 'outbound'}`}><small>{item.direction === 'inbound' ? 'Customer' : 'Bhavesh Pipes'}</small><p>{item.body}</p><time>{item.status}</time></article>)}</div><div className="chat-controls"><button className="secondary-btn" onClick={toggleAI} disabled={busy}>{conversation.ai_enabled ? 'Pause AI' : 'Resume AI'}</button><button className="secondary-btn" onClick={takeOver} disabled={busy || conversation.status === 'human_takeover'}>Take Over</button><button className="secondary-btn" onClick={resolve} disabled={busy || conversation.status === 'resolved'}>Mark Resolved</button></div><form className="reply-form" onSubmit={sendReply}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a WhatsApp reply..." aria-label="WhatsApp reply" /><button className="primary-btn" disabled={busy || !draft.trim()}>Send Reply</button></form></> : <div className="empty-preview">Select a conversation to view its history.</div>}</section>
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

function ContactsView() {
  const [contacts, setContacts] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [stats, setStats] = useState({ total: 0, optedIn: 0, optedOut: 0 })
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState({ name: '', company: '', city: '', notes: '', tags: '', marketing_opt_in: true })
  const [deleteId, setDeleteId] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
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
    } catch (error) { setNotice({ type: 'error', text: error.message }) }
  }

  useEffect(() => { load() }, [search, page])

  const selectContact = (contact) => {
    setSelected(contact)
    setForm({ name: contact.name || '', company: contact.company || '', city: contact.city || '', notes: contact.notes || '', tags: Array.isArray(contact.tags) ? contact.tags.join(', ') : contact.tags || '', marketing_opt_in: !!contact.marketing_opt_in })
    setDeleteId(null)
  }

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    try {
      await apiFetch(`/contacts/${selected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean) }) })
      setNotice({ type: 'success', text: 'Contact updated.' }); setSelected(null); await load()
    } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const optOut = async (contact) => {
    setBusy(true)
    try { await apiFetch(`/contacts/${contact.id}/optout`, { method: 'POST' }); setNotice({ type: 'success', text: `${displayIdentity(contact)} opted out.` }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const toggleContact = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllContacts = () => setSelectedIds(selectedIds.length === contacts.length ? [] : contacts.map((contact) => contact.id))
  const bulkDelete = async () => {
    if (!selectedIds.length || !window.confirm(`Delete ${selectedIds.length} selected contact(s)?`)) return
    setBusy(true)
    try { await apiFetch('/contacts/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setNotice({ type: 'success', text: `${selectedIds.length} contact(s) deleted.` }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const remove = async (contact) => {
    if (deleteId !== contact.id) return setDeleteId(contact.id)
    setBusy(true)
    try { await apiFetch(`/contacts/${contact.id}`, { method: 'DELETE' }); setDeleteId(null); setSelected(null); setNotice({ type: 'success', text: 'Contact deleted.' }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  const pageCount = Math.max(1, Math.ceil(total / limit))
  return <div className="view-workspace">
    <div className="view-toolbar"><div><p className="eyebrow">Customer directory</p><h2>Contacts</h2><p className="muted-copy">Keep customer details, consent, and conversation context in one place.</p></div><input className="search-input" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Search contacts" /></div>
    {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    <div className="stats-grid compact-stats">{[['Total contacts', stats.total, 'green'], ['Opted in', stats.optedIn, 'blue'], ['Opted out', stats.optedOut, 'amber']].map(([label, value, accent]) => <article className={`stat-card ${accent}`} key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
    {selected && <section className="panel editor-panel"><div className="panel-header"><div><p className="eyebrow">Editing contact</p><h2>{selected.name || selected.phone}</h2></div><button className="secondary-btn" onClick={() => setSelected(null)}>Close</button></div><form className="form-grid" onSubmit={save}><label className="form-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label className="form-label">Company<input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></label><label className="form-label">City<input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></label><label className="form-label">Tags<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="dealer, priority" /></label><label className="form-label full-field">Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label className="check-label full-field"><input type="checkbox" checked={form.marketing_opt_in} onChange={(event) => setForm({ ...form, marketing_opt_in: event.target.checked })} /> Marketing opt-in</label><div className="button-row full-field"><button className="primary-btn" disabled={busy}>Save changes</button></div></form></section>}
    <section className="panel"><div className="panel-header"><h2>All contacts</h2><span className="file-note">{total} records</span></div>{selectedIds.length > 0 && <div className="button-row"><span>{selectedIds.length} selected</span><button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button></div>}<div className="campaign-table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all contacts on this page" checked={contacts.length > 0 && selectedIds.length === contacts.length} onChange={toggleAllContacts} /></th><th>Phone</th><th>Name</th><th>Company</th><th>City</th><th>Opt-in</th><th>Last message</th><th>Actions</th></tr></thead><tbody>{contacts.map((contact) => <tr key={contact.id} onClick={() => selectContact(contact)}><td onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${contact.name || contact.phone}`} checked={selectedIds.includes(contact.id)} onChange={() => toggleContact(contact.id)} /></td><td>{contact.phone}</td><td>{contact.name || 'Unknown'}</td><td>{contact.company || '-'}</td><td>{contact.city || '-'}</td><td><span className={`campaign-status ${contact.marketing_opt_in ? 'running' : 'stopped'}`}>{contact.marketing_opt_in ? 'Opted in' : 'Opted out'}</span></td><td>{formatDate(contact.last_message_at)}</td><td><div className="button-row" onClick={(event) => event.stopPropagation()}><button className="secondary-btn" onClick={() => optOut(contact)} disabled={busy || !contact.marketing_opt_in}>Opt out</button><button className="danger-btn" onClick={() => remove(contact)} disabled={busy}>{deleteId === contact.id ? 'Confirm delete' : 'Delete'}</button></div></td></tr>)}</tbody></table>{!contacts.length && <div className="empty-preview">No contacts match this search.</div>}</div><div className="pagination"><button className="secondary-btn" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>Previous</button><span>Page {page} of {pageCount}</span><button className="secondary-btn" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>Next</button></div></section>
  </div>
}

function TemplatesView() {
  const [templates, setTemplates] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [form, setForm] = useState({ name: '', content: '' })
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const load = async () => { try { setTemplates(await apiFetch('/templates')) } catch (error) { setNotice({ type: 'error', text: error.message }) } }
  useEffect(() => { load() }, [])
  const submit = async (event) => { event.preventDefault(); setBusy(true); try { await apiFetch(editing ? `/templates/${editing}` : '/templates', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }); setForm({ name: '', content: '' }); setEditing(null); setNotice({ type: 'success', text: editing ? 'Template updated.' : 'Template created.' }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) } }
  const duplicate = async (id) => { try { await apiFetch(`/templates/${id}/duplicate`, { method: 'POST' }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } }
  const remove = async (id) => { if (!window.confirm('Delete this template?')) return; try { await apiFetch(`/templates/${id}`, { method: 'DELETE' }); setSelectedIds((current) => current.filter((item) => item !== id)); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } }
  const bulkDelete = async () => { if (!selectedIds.length || !window.confirm(`Delete ${selectedIds.length} selected template(s)?`)) return; setBusy(true); try { await apiFetch('/templates/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setNotice({ type: 'success', text: `${selectedIds.length} template(s) deleted.` }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) } }
  const toggleTemplate = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllTemplates = () => setSelectedIds(selectedIds.length === templates.length ? [] : templates.map((template) => template.id))
  const loadExample = (exampleType) => {
    if (exampleType === 'inquiry') {
      setForm({ name: 'Product Inquiry Follow-up', content: `Hello {{name}} 👋\n\nThis is Bhavesh Pipes.\nWe wanted to know if {{company}} currently has any requirements for {{product}} in {{city}}.\n\nPlease let us know your required quantity and timeline.\n\nBest regards,\nBhavesh Pipes Team` })
    } else if (exampleType === 'reengagement') {
      setForm({ name: 'Re-engagement Offer', content: `Hi {{name}},\n\nIt's been a while since we last connected. We'd love to reconnect with {{company}}.\n\nWe've recently expanded our {{product}} range and would like to discuss how we can better serve your needs in {{city}}.\n\nWould you be interested in a quick call this week?\n\nBest regards,\nBhavesh Pipes` })
    } else if (exampleType === 'promotion') {
      setForm({ name: 'Promotional Announcement', content: `Hi {{name}},\n\nExciting news! Bhavesh Pipes is launching a special promotion on {{product}}.\n\nLimited time offer:\n• Competitive pricing\n• Fast delivery to {{city}}\n• Dedicated support for bulk orders\n\nReply with "More Info" to learn more, or reach out directly.\n\nBhavesh Pipes Team` })
    }
  }
  return <div className="view-workspace"><div><p className="eyebrow">Reusable messages</p><h2>Templates</h2><p className="muted-copy">Build consistent messages with fields that personalize at send time.</p></div>{notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}<div className="split-view"><section className="panel"><div className="panel-header"><h2>{editing ? 'Edit template' : 'New template'}</h2>{editing && <button className="secondary-btn" onClick={() => { setEditing(null); setForm({ name: '', content: '' }) }}>Cancel</button>}</div><form className="campaign-builder form-stack" onSubmit={submit}><label className="form-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label className="form-label">Content<textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} required /><small className="help-note">Fields like <code>{"{{name}}"}</code>, <code>{"{{company}}"}</code>, <code>{"{{product}}"}</code>, <code>{"{{city}}"}</code> are replaced with actual data from your Excel sheet. Example: <code>{"Hi {{name}}"}</code> becomes "Hi Rajesh" when name=Rajesh in your upload.</small></label><button className="primary-btn" disabled={busy}>{editing ? 'Update template' : 'Create template'}</button></form><div className="button-row"><button type="button" className="secondary-btn" onClick={() => loadExample('inquiry')} disabled={busy}>Load example: Product Inquiry</button><button type="button" className="secondary-btn" onClick={() => loadExample('reengagement')} disabled={busy}>Load example: Re-engagement</button><button type="button" className="secondary-btn" onClick={() => loadExample('promotion')} disabled={busy}>Load example: Promotion</button></div></section><section className="template-grid"><div className="panel-header"><span>{selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Select templates'}</span><div className="button-row"><label className="check-label"><input type="checkbox" aria-label="Select all templates" checked={templates.length > 0 && selectedIds.length === templates.length} onChange={toggleAllTemplates} /> All</label>{selectedIds.length > 0 && <button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button>}</div></div>{templates.map((template) => <article className="panel template-card" key={template.id}><div className="panel-header"><label className="check-label"><input type="checkbox" aria-label={`Select ${template.name}`} checked={selectedIds.includes(template.id)} onChange={() => toggleTemplate(template.id)} /> Select</label><small className="file-note">Updated {formatDate(template.updated_at)}</small></div><h2>{template.name}</h2><p className="template-preview"><PlaceholderPreview content={template.content} /></p><div className="button-row"><button className="secondary-btn" onClick={() => { setEditing(template.id); setForm({ name: template.name, content: template.content }) }}>Edit</button><button className="secondary-btn" onClick={() => duplicate(template.id)}>Duplicate</button><button className="danger-btn" onClick={() => remove(template.id)}>Delete</button></div></article>)}{!templates.length && <div className="panel empty-preview">No templates created yet.</div>}</section></div></div>
}

function KnowledgeBaseView() {
  const [documents, setDocuments] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [form, setForm] = useState({ name: '', category: 'general', content: '' })
  const [file, setFile] = useState(null)
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const load = async () => { try { setDocuments(await apiFetch('/knowledge')) } catch (error) { setNotice({ type: 'error', text: error.message }) } }
  useEffect(() => { load() }, [])
  const save = async (event) => { event.preventDefault(); setBusy(true); try { await apiFetch(editing ? `/knowledge/${editing}` : '/knowledge', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }); setForm({ name: '', category: 'general', content: '' }); setEditing(null); setNotice({ type: 'success', text: editing ? 'Document updated.' : 'Document added.' }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) } }
  const upload = async (event) => { event.preventDefault(); if (!file) return; setBusy(true); const formData = new FormData(); formData.append('file', file); formData.append('name', form.name); formData.append('category', form.category); try { await apiFetch('/knowledge/upload', { method: 'POST', body: formData }); setFile(null); setForm({ name: '', category: 'general', content: '' }); setNotice({ type: 'success', text: 'Document uploaded.' }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) } }
  const remove = async (id) => { if (!window.confirm('Delete this document?')) return; try { await apiFetch(`/knowledge/${id}`, { method: 'DELETE' }); setSelectedIds((current) => current.filter((item) => item !== id)); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } }
  const bulkDelete = async () => { if (!selectedIds.length || !window.confirm(`Delete ${selectedIds.length} selected document(s)?`)) return; setBusy(true); try { await apiFetch('/knowledge/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }) }); setSelectedIds([]); setNotice({ type: 'success', text: `${selectedIds.length} document(s) deleted.` }); await load() } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) } }
  const toggleDocument = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAllDocuments = () => setSelectedIds(selectedIds.length === documents.length ? [] : documents.map((document) => document.id))
  const edit = async (id) => { try { const doc = await apiFetch(`/knowledge/${id}`); setEditing(id); setForm({ name: doc.name, category: doc.category, content: doc.content }) } catch (error) { setNotice({ type: 'error', text: error.message }) } }
  const loadExample = (exampleType) => {
    if (exampleType === 'spec') {
      setForm({ name: 'UGD Pipe Specifications', category: 'Product Specs', content: `Diameter Range: 20mm to 110mm\nMaterial Grade: Grade B, Grade C, Grade D\nStandard Compliance: IS 651:2015 (uPVC pipes for water supply)\n\nTypical Use Cases:\n- Municipal water distribution networks\n- Agricultural irrigation systems\n- Industrial process water applications\n\nKey Performance Features:\n- Corrosion-resistant uPVC construction\n- Lightweight and easy to install\n- Hydrostatic strength rated for 10-16 bar working pressure\n- UV-stabilized for outdoor applications\n- Long service life of 50+ years with minimal maintenance` })
    } else if (exampleType === 'faq') {
      setForm({ name: 'UGD Pipes - Frequently Asked Questions', category: 'FAQ', content: `Q: What is the difference between Grade B and Grade C pipes?\nA: Grade C pipes have higher hydrostatic strength and are suitable for higher pressure applications. Grade B is standard for municipal water supply.\n\nQ: Can UGD pipes be used for hot water?\nA: No, uPVC pipes are designed for cold water applications only. Exposure to temperatures above 40°C may damage the pipes.\n\nQ: How long do UGD pipes last?\nA: With proper installation and maintenance, UGD pipes have a service life of 50 years or more.\n\nQ: Are UGD pipes environmentally friendly?\nA: Yes, uPVC is recyclable and the pipes don't leach harmful chemicals into water.` })
    }
  }
  return <div className="view-workspace"><div><p className="eyebrow">AI context library</p><h2>Knowledge Base</h2><p className="muted-copy">This content feeds the AI's replies through the knowledge base lookup.</p></div>{notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}<div className="split-view"><section className="panel"><div className="panel-header"><h2>{editing ? 'Edit document' : 'Add text'}</h2>{editing && <button className="secondary-btn" onClick={() => { setEditing(null); setForm({ name: '', category: 'general', content: '' }) }}>Cancel</button>}</div><form className="form-stack" onSubmit={save}><label className="form-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label className="form-label">Category<input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></label><label className="form-label">Content<textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} required /></label><div className="help-note"><strong>Tips for good entries:</strong> Be specific and factual. Keep one topic per entry. Avoid mixing unrelated products. Strong entries directly improve AI reply accuracy.</div><button className="primary-btn" disabled={busy}>{editing ? 'Update document' : 'Add document'}</button></form><div className="button-row"><button type="button" className="secondary-btn" onClick={() => loadExample('spec')} disabled={busy}>Load example: Product Specs</button><button type="button" className="secondary-btn" onClick={() => loadExample('faq')} disabled={busy}>Load example: FAQ</button></div><div className="upload-divider"><span>or upload a file</span></div><form className="form-stack" onSubmit={upload}><label className="upload-dropzone">{file ? file.name : 'Choose TXT, MD, PDF, or DOCX'}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label><button className="secondary-btn" disabled={busy || !file}>Upload document</button></form></section><section className="panel"><div className="panel-header"><h2>Documents</h2><span className="file-note">{documents.length} sources</span></div><div className="button-row"><label className="check-label"><input type="checkbox" aria-label="Select all knowledge documents" checked={documents.length > 0 && selectedIds.length === documents.length} onChange={toggleAllDocuments} /> All</label>{selectedIds.length > 0 && <><span>{selectedIds.length} selected</span><button className="danger-btn" onClick={bulkDelete} disabled={busy}>Delete selected</button></>}</div><div className="campaign-table-wrap"><table><thead><tr><th>Select</th><th>Name</th><th>Category</th><th>Status</th><th>Length</th><th>Added</th><th /></tr></thead><tbody>{documents.map((document) => <tr key={document.id}><td><input type="checkbox" aria-label={`Select ${document.name}`} checked={selectedIds.includes(document.id)} onChange={() => toggleDocument(document.id)} /></td><td><strong>{document.name}</strong></td><td>{document.category}</td><td><span className={`campaign-status ${document.status === 'active' ? 'running' : 'paused'}`}>{document.status}</span></td><td>{document.content_length} chars</td><td>{formatDate(document.created_at)}</td><td><div className="button-row"><button className="secondary-btn" onClick={() => edit(document.id)}>Edit</button><button className="danger-btn" onClick={() => remove(document.id)}>Delete</button></div></td></tr>)}</tbody></table>{!documents.length && <div className="empty-preview">No knowledge documents yet.</div>}</div></section></div></div>
}

function AnalyticsView() {
  const [dashboard, setDashboard] = useState(null)
  const [trend, setTrend] = useState([])
  const [notice, setNotice] = useState({ type: '', text: '' })
  useEffect(() => { Promise.all([apiFetch('/analytics/dashboard'), apiFetch('/analytics/messages/trend?days=7')]).then(([data, nextTrend]) => { setDashboard({ ...data, recentMessages: (data.recentMessages || []).map((message) => ({ ...message, name: displayIdentity(message) })) }); setTrend(nextTrend || []) }).catch((error) => setNotice({ type: 'error', text: error.message })) }, [])
  if (!dashboard) return <div className="view-workspace">{notice.text ? <div className="notice error">{notice.text}</div> : <div className="panel empty-preview">Loading analytics...</div>}</div>
  const cards = [['Active contacts', dashboard.contacts.active, 'green'], ['Opted-out contacts', dashboard.contacts.optedOut, 'amber'], ['Open conversations', dashboard.conversations.open, 'blue'], ['Human takeover', dashboard.conversations.human_takeover, 'violet'], ['Resolved', dashboard.conversations.resolved, 'green'], ['Inbound messages', dashboard.messages.inbound, 'blue'], ['Outbound messages', dashboard.messages.outbound, 'violet'], ['Campaigns sent', dashboard.campaigns.total_sent, 'green'], ['Campaigns failed', dashboard.campaigns.total_failed, 'amber'], ['Campaign replies', dashboard.campaigns.total_replies, 'blue'], ['Campaign opt-outs', dashboard.campaigns.total_opt_outs, 'violet']]
  const maxValue = Math.max(1, ...trend.flatMap((item) => [item.inbound || 0, item.outbound || 0]))
  return <div className="view-workspace"><div><p className="eyebrow">Performance overview</p><h2>Analytics</h2><p className="muted-copy">A compact view of customer activity, campaigns, and message flow.</p></div>{notice.text && <div className="notice error">{notice.text}</div>}<div className="stats-grid analytics-stats">{cards.map(([label, value, accent]) => <article className={`stat-card ${accent}`} key={label}><span>{label}</span><strong>{value || 0}</strong></article>)}</div><div className="analytics-grid"><section className="panel"><div className="panel-header"><h2>Message trend</h2><span className="file-note">Last 7 days</span></div><div className="trend-chart">{trend.map((item) => <div className="trend-day" key={item.date}><div className="trend-bars"><i className="inbound-bar" style={{ height: `${Math.max(4, ((item.inbound || 0) / maxValue) * 100)}%` }} /><i className="outbound-bar" style={{ height: `${Math.max(4, ((item.outbound || 0) / maxValue) * 100)}%` }} /></div><small>{item.date.slice(5)}</small><span>{item.inbound || 0} / {item.outbound || 0}</span></div>)}</div><div className="chart-legend"><span><i className="inbound-bar" /> Inbound</span><span><i className="outbound-bar" /> Outbound</span></div></section><section className="panel"><div className="panel-header"><h2>Recent messages</h2></div><ul className="list recent-message-list">{dashboard.recentMessages.map((message, index) => <li key={`${message.created_at}-${index}`}><div><strong>{message.name || message.phone}</strong><small>{message.body}</small></div><span className={`campaign-status ${message.direction === 'inbound' ? 'running' : 'completed'}`}>{message.direction}</span></li>)}</ul>{!dashboard.recentMessages.length && <div className="empty-preview">No messages yet.</div>}</section></div><section className="panel"><div className="panel-header"><h2>Recent campaigns</h2></div><div className="campaign-table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Sent</th><th>Failed</th><th>Replies</th><th>Opt-outs</th></tr></thead><tbody>{dashboard.recentCampaigns.map((campaign) => <tr key={campaign.id}><td><strong>{campaign.name}</strong><small>{formatDate(campaign.created_at)}</small></td><td><span className={`campaign-status ${String(campaign.status).toLowerCase()}`}>{campaign.status}</span></td><td>{campaign.sent}</td><td>{campaign.failed}</td><td>{campaign.replies}</td><td>{campaign.opt_outs}</td></tr>)}</tbody></table>{!dashboard.recentCampaigns.length && <div className="empty-preview">No campaign activity yet.</div>}</div></section></div>
}

function SettingsView() {
  const [settings, setSettings] = useState(null)
  const [form, setForm] = useState({ aiApiKey: '', aiBaseURL: '', aiModel: '', businessName: '', businessTagline: '' })
  const [showKey, setShowKey] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { apiFetch('/settings').then(setSettings).catch((error) => setNotice({ type: 'error', text: error.message })) }, [])
  useEffect(() => { if (settings) setForm((current) => ({ ...current, aiBaseURL: settings.ai.baseURL, aiModel: settings.ai.model, businessName: settings.business.name, businessTagline: settings.business.tagline })) }, [settings])
  const save = async (event) => { event.preventDefault(); setBusy(true); const payload = Object.fromEntries(Object.entries(form).filter(([, value]) => value.trim())); try { const updated = await apiFetch('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); setSettings(updated); setForm({ aiApiKey: '', aiBaseURL: updated.ai.baseURL, aiModel: updated.ai.model, businessName: updated.business.name, businessTagline: updated.business.tagline }); setShowKey(false); setNotice({ type: 'success', text: 'Settings saved.' }) } catch (error) { setNotice({ type: 'error', text: error.message }) } finally { setBusy(false) } }
  if (!settings) return <div className="view-workspace">{notice.text ? <div className="notice error">{notice.text}</div> : <div className="panel empty-preview">Loading settings...</div>}</div>
  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value })
  return <div className="view-workspace"><div><p className="eyebrow">Server configuration</p><h2>Settings</h2><p className="muted-copy">Update the AI connection and business details stored in the server environment.</p></div>{notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}<form onSubmit={save}><section className="panel settings-panel"><div className="panel-header"><h2>AI assistant</h2><span className={`campaign-status ${settings.ai.available ? 'running' : 'stopped'}`}>{settings.ai.available ? 'Available' : 'Unavailable'}</span></div><div className="settings-grid"><label className="form-label">API key<div className="input-with-action"><input type={showKey ? 'text' : 'password'} value={form.aiApiKey} onChange={update('aiApiKey')} placeholder="Leave blank to keep current key" autoComplete="new-password" /><button type="button" className="secondary-btn" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button></div><small>Configured via the server's .env file. Leave blank to keep the current key.</small></label><label className="form-label">Base URL<input value={form.aiBaseURL} onChange={update('aiBaseURL')} /><small>Configured via the server's .env file.</small></label><label className="form-label">Model<input value={form.aiModel} onChange={update('aiModel')} /><small>Configured via the server's .env file.</small></label></div></section><section className="panel settings-panel"><div className="panel-header"><h2>Business information</h2></div><div className="settings-grid"><label className="form-label">Business name<input value={form.businessName} onChange={update('businessName')} /><small>Configured via the server's .env file.</small></label><label className="form-label">Tagline<input value={form.businessTagline} onChange={update('businessTagline')} /><small>Configured via the server's .env file.</small></label></div></section><div className="button-row"><button className="primary-btn" disabled={busy}>{busy ? 'Saving...' : 'Save settings'}</button></div></form></div>
}

function App() {
  const [activeView, setActiveView] = useState('Dashboard')
  const [backendStatus, setBackendStatus] = useState('Checking...')
  const [isConnected, setIsConnected] = useState(false)
  const [dashboard, setDashboard] = useState(null)
  const [recentConversations, setRecentConversations] = useState(null)
  const [dashboardError, setDashboardError] = useState('')

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const response = await fetch('http://localhost:3000/api/health')
        if (!response.ok) throw new Error('Unavailable')
        const data = await response.json()
        setBackendStatus(data.whatsapp || 'connected')
        setIsConnected(data.whatsapp === 'connected')
      } catch {
        setBackendStatus('offline')
        setIsConnected(false)
      }
    }

    loadStatus()
    const interval = window.setInterval(loadStatus, 10000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
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
        setDashboardError(error.message)
      }
    }

    loadDashboard()
    const interval = window.setInterval(loadDashboard, 10000)
    return () => window.clearInterval(interval)
  }, [])

  const stats = dashboard ? [
    { label: 'Total Contacts', value: dashboard.contacts.total, accent: 'green' },
    { label: 'Active Campaigns', value: dashboard.campaigns.active, accent: 'blue' },
    { label: 'Inbound Messages', value: dashboard.messages.inbound, accent: 'violet' },
    {
      label: 'WhatsApp Status',
      value: isConnected ? '🟢 Connected' : '🔴 Offline',
      accent: isConnected ? 'green' : 'amber',
    },
  ] : []

  const renderView = () => {
    if (activeView === 'Dashboard') return <LeadPriorityDashboard />
    if (activeView === 'WhatsApp Connection') return <ConnectionView />
    if (activeView === 'Campaigns') return <CampaignsView />
    if (activeView === 'Inbox') return <InboxView />
    if (activeView === 'Contacts') return <ContactsView />
    if (activeView === 'Templates') return <TemplatesView />
    if (activeView === 'Knowledge Base') return <KnowledgeBaseView />
    if (activeView === 'Analytics') return <AnalyticsView />
    if (activeView === 'Settings') return <SettingsView />
    if (activeView === 'Image Extractor') return <ImageExtractorView />
    if (activeView === 'Dashboard') {
      if (!dashboard || !recentConversations) {
        return <div className="panel empty-preview">{dashboardError || 'Loading dashboard...'}</div>
      }

      return (
        <>
          <section className="stats-grid">
            {stats.map((stat) => (
              <article key={stat.label} className={`stat-card ${stat.accent}`}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </article>
            ))}
          </section>

          <section className="content-grid">
            <article className="panel">
              <div className="panel-header">
                <h2>Recent campaigns</h2>
                <button type="button">View all</button>
              </div>
              <ul className="list">
                {dashboard.recentCampaigns.map((campaign) => (
                  <li key={campaign.id}>
                    <div>
                      <strong>{campaign.name}</strong>
                      <small>{campaign.sent || 0} / {campaign.total_contacts || 0} sent</small>
                    </div>
                    <span className="tag">{campaign.status}</span>
                  </li>
                ))}
              </ul>
              {!dashboard.recentCampaigns.length && <div className="empty-preview">No campaigns created yet.</div>}
            </article>

            <article className="panel">
              <div className="panel-header">
                <h2>Recent conversations</h2>
                <button type="button">Inbox</button>
              </div>
              <ul className="list conversation-list">
                {recentConversations.map((conversation) => (
                  <li key={conversation.id}>
                    <div>
                      <strong>{displayIdentity(conversation)}</strong>
                      <small>{conversation.last_message || 'No messages yet'}</small>
                    </div>
                    <span className="tag muted">{conversation.status === 'human_takeover' ? 'Human Handoff' : conversation.ai_enabled ? 'AI Active' : 'Human Active'}</span>
                  </li>
                ))}
              </ul>
              {!recentConversations.length && <div className="empty-preview">No conversations yet.</div>}
            </article>
          </section>

          <section className="panel message-editor"><div className="panel-header"><h2>Campaign message composer</h2><button type="button" onClick={() => setActiveView('Campaigns')}>Open campaign manager</button></div><p className="muted-copy">Create an Excel-backed campaign with dynamic fields and queue controls.</p></section>
        </>
      )
    }

    return (
      <section className="panel empty-state-panel">
        <h2>{activeView}</h2>
        <p>This section is ready for the next feature slice.</p>
        <button type="button" className="primary-btn" onClick={() => setActiveView('Dashboard')}>
          Back to dashboard
        </button>
      </section>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Bhavesh Pipes</div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item}
              type="button"
              className={item === activeView ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveView(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Good afternoon</p>
            <h1>{activeView}</h1>
          </div>
          <div className={`status-pill ${isConnected ? 'online' : 'offline'}`}>
            {isConnected ? '🟢 WhatsApp Connected' : '🔴 WhatsApp Offline'}
          </div>
        </header>

        <div className="backend-status">
          Backend: <strong>{backendStatus}</strong>
        </div>

        {renderView()}
      </main>
    </div>
  )
}

export default App
