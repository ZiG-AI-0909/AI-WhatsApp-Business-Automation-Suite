import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import EmptyState from './components/EmptyState.jsx'
import Icon from './components/Icon.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Bulk email campaigns — the email twin of WhatsApp Campaigns. Sends for free
// through the user's own Gmail / Outlook / Zoho account (Settings → Email).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BODY = `Hello {{name}},

We have a special offer on pipes and fittings this month.

Reply to this email or call us to know more.

Regards,
Sudarshan Pipes`

const STATUS_TEXT = {
  draft: 'Draft',
  running: 'Sending',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Finished',
  completed_with_errors: 'Finished — some failed',
}
const RECIPIENT_STATUS = { pending: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' }

const statusClass = (status) => `campaign-status ${status === 'completed_with_errors' ? 'completed-with-errors' : status === 'completed' ? 'completed' : status}`

function formatDuration(seconds) {
  if (seconds < 60) return 'less than a minute'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `about ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}`
}

function remainingOf(c) {
  return Math.max(0, (c.total || 0) - (c.sent || 0) - (c.failed || 0) - (c.skipped || 0))
}

export default function EmailCampaignsView({ onNavigate }) {
  const [sender, setSender] = useState(null)
  const [campaigns, setCampaigns] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [recipientsView, setRecipientsView] = useState({ status: '', list: [], total: 0 })
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const [migrationPending, setMigrationPending] = useState('')

  // Builder state
  const [name, setName] = useState('')
  const [source, setSource] = useState('file')
  const [fileName, setFileName] = useState('')
  const [pasted, setPasted] = useState('')
  const [list, setList] = useState(null)
  const [subject, setSubject] = useState('Special offer for {{name}}')
  const [body, setBody] = useState(DEFAULT_BODY)
  const [delaySeconds, setDelaySeconds] = useState('5')
  const [dailyLimit, setDailyLimit] = useState('400')
  const [previews, setPreviews] = useState([])
  const [previewIndex, setPreviewIndex] = useState(0)
  const bodyRef = useRef(null)

  const selected = campaigns.find((c) => c.id === selectedId) || null

  const handleError = useCallback((error, context) => {
    if (error?.code === 'EMAIL_MIGRATION_PENDING' || /one-time database update/i.test(error?.message || '')) {
      setMigrationPending(error.message)
      return
    }
    setNotice({ type: 'error', text: friendlyErrorMessage(error, { context }) })
  }, [])

  const loadCampaigns = useCallback(async () => {
    try {
      const data = await apiFetch('/email-campaigns')
      setCampaigns(data.campaigns || [])
      setMigrationPending('')
    } catch (error) { handleError(error, 'Loading email campaigns') }
  }, [handleError])

  const loadRecipients = useCallback(async (id, status) => {
    if (!id) return
    try {
      const data = await apiFetch(`/email-campaigns/${id}/recipients?limit=100${status ? `&status=${status}` : ''}`)
      setRecipientsView({ status: status || '', list: data.recipients || [], total: data.total || 0 })
    } catch (error) { handleError(error, 'Loading recipients') }
  }, [handleError])

  useEffect(() => {
    apiFetch('/email-campaigns/sender').then(setSender).catch(() => setSender({ ready: false }))
    loadCampaigns()
  }, [loadCampaigns])

  // Refresh while anything is sending.
  const anyRunning = campaigns.some((c) => c.status === 'running')
  useEffect(() => {
    if (!anyRunning) return undefined
    const timer = setInterval(() => {
      loadCampaigns()
      if (selectedId) loadRecipients(selectedId, recipientsView.status)
    }, 4000)
    return () => clearInterval(timer)
  }, [anyRunning, loadCampaigns, loadRecipients, selectedId, recipientsView.status])

  useEffect(() => { if (selectedId) loadRecipients(selectedId, '') }, [selectedId, loadRecipients])

  // Live preview (debounced) for the first three recipients.
  useEffect(() => {
    if (!subject.trim() || !body.trim()) { setPreviews([]); return undefined }
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch('/email-campaigns/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject, body, recipients: list?.recipients?.slice(0, 3) || [] }),
        })
        setPreviews(data.previews || [])
      } catch { /* preview is best effort */ }
    }, 400)
    return () => clearTimeout(timer)
  }, [subject, body, list])

  const fields = useMemo(() => {
    const cols = new Set(['name'])
    for (const col of list?.columns || []) if (col) cols.add(col)
    return [...cols]
  }, [list])

  const insertField = (field) => {
    const token = `{{${field}}}`
    const el = bodyRef.current
    if (!el) { setBody((b) => `${b}${token}`); return }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    const next = body.slice(0, start) + token + body.slice(end)
    setBody(next)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
  }

  const uploadFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true); setNotice({ type: '', text: '' })
    try {
      const formData = new FormData()
      formData.append('file', file)
      const data = await apiFetch('/email-campaigns/parse', { method: 'POST', body: formData })
      setList(data); setFileName(file.name)
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ''))
    } catch (error) { setList(null); handleError(error, 'Reading the email list') } finally { setBusy(false) }
  }

  const usePasted = async () => {
    setBusy(true); setNotice({ type: '', text: '' })
    try {
      const data = await apiFetch('/email-campaigns/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: pasted }) })
      setList(data); setFileName('')
    } catch (error) { setList(null); handleError(error, 'Reading the pasted addresses') } finally { setBusy(false) }
  }

  const sendTest = async () => {
    setBusy(true); setNotice({ type: '', text: '' })
    try {
      const result = await apiFetch('/email-campaigns/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body, recipient: list?.recipients?.[0] }),
      })
      setNotice({ type: 'success', text: result.message })
    } catch (error) { handleError(error, 'Sending the test email') } finally { setBusy(false) }
  }

  const createCampaign = async (startNow) => {
    if (!list?.recipients?.length) { setNotice({ type: 'error', text: 'Add your email list first (step 1).' }); return }
    if (startNow && !window.confirm(`Send this email to ${list.recipients.length} people now?`)) return
    setBusy(true); setNotice({ type: '', text: '' })
    try {
      const campaign = await apiFetch('/email-campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, subject, body, recipients: list.recipients, settings: { delaySeconds: Number(delaySeconds), dailyLimit: Number(dailyLimit) }, startNow }),
      })
      setNotice({ type: 'success', text: startNow ? `"${campaign.name}" is sending. You can leave this page — it keeps going.` : `"${campaign.name}" saved as a draft.` })
      setList(null); setFileName(''); setPasted(''); setName('')
      await loadCampaigns()
      setSelectedId(campaign.id)
    } catch (error) { handleError(error, 'Creating the email campaign') } finally { setBusy(false) }
  }

  const control = async (action, campaign = selected) => {
    if (!campaign) return
    if (action === 'stop' && !window.confirm('Stop this campaign? Emails not sent yet will not be sent.')) return
    if (action === 'delete' && !window.confirm(`Delete "${campaign.name}" and its history?`)) return
    setBusy(true); setNotice({ type: '', text: '' })
    try {
      if (action === 'delete') {
        await apiFetch(`/email-campaigns/${campaign.id}`, { method: 'DELETE' })
        if (selectedId === campaign.id) setSelectedId(null)
      } else {
        await apiFetch(`/email-campaigns/${campaign.id}/${action}`, { method: 'POST' })
      }
      await loadCampaigns()
      if (action !== 'delete') loadRecipients(campaign.id, recipientsView.status)
    } catch (error) { handleError(error, 'Updating the campaign') } finally { setBusy(false) }
  }

  const preview = previews[previewIndex] || previews[0]
  const missing = [...new Set(previews.flatMap((p) => p.missingFields || []))]
  const recipientCount = list?.recipients?.length || 0
  const estimate = recipientCount ? formatDuration(Math.min(recipientCount, Number(dailyLimit) || 400) * (Number(delaySeconds) || 5)) : ''

  if (migrationPending) {
    return <div className="view-workspace"><div className="notice warning">{migrationPending}</div></div>
  }

  return <div className="view-workspace">
    <div>
      <p className="eyebrow">Email</p>
      <h2>Bulk email campaigns</h2>
      <p className="muted-copy">Send a personalised email to your whole customer list — free, from your own Gmail or business email account.</p>
    </div>

    {sender && !sender.ready && <div className="notice warning">
      <strong>Connect your email account first.</strong> In Settings → Email, enter your Gmail address and a Gmail App Password. It is free and takes two minutes.{' '}
      <button type="button" onClick={() => onNavigate?.('Settings')}>Open Settings</button>
    </div>}
    {sender?.ready && <div className="notice info">
      Sending from <strong>{sender.provider === 'smtp' ? sender.smtp?.user : sender.resend?.fromEmail}</strong>. Free Gmail accounts can send about 500 emails a day; larger lists continue automatically the next day.
    </div>}
    {notice.text && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}

    <div className="campaign-layout">
      <section className="panel campaign-builder">
        <div className="panel-header"><div><p className="eyebrow">New email campaign</p><h2>Build your email</h2></div><span className="file-note">{recipientCount ? `${recipientCount} recipients` : 'No list yet'}</span></div>

        <fieldset className="builder-step">
          <legend><span className="step-index" aria-hidden="true">1</span>Who gets it</legend>
          <label className="form-label">Campaign name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dealer offer - November" /></label>
          <div className="lead-filters" role="tablist">
            <button type="button" className={source === 'file' ? 'active' : ''} onClick={() => setSource('file')}>Upload Excel / CSV</button>
            <button type="button" className={source === 'paste' ? 'active' : ''} onClick={() => setSource('paste')}>Paste addresses</button>
          </div>
          {source === 'file' ? <>
            <div className="upload-row">
              <label className="secondary-btn upload-btn"><Icon name="upload" size={16} />{fileName ? 'Choose another file' : 'Choose file'}<input type="file" accept=".xlsx,.csv" onChange={uploadFile} disabled={busy} /></label>
              <span className="file-note">{fileName || 'Your file needs a column called "Email". Other columns (Name, City…) can be used in the message.'}</span>
            </div>
          </> : <>
            <label className="form-label">One person per line<textarea rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'rajesh@example.com\nAsha Traders, asha@example.com'} /></label>
            <div className="button-row"><button type="button" className="secondary-btn" onClick={usePasted} disabled={busy || !pasted.trim()}>Use these addresses</button></div>
          </>}
          {list && <div className="validation-summary">
            <strong>{list.recipients.length} valid emails</strong>
            <span>{list.duplicates} duplicates removed</span>
            <span>{list.invalidCount} not valid</span>
          </div>}
          {list?.invalidCount > 0 && <details className="muted-copy"><summary>See addresses that were not valid</summary><ul>{list.invalid.slice(0, 20).map((row, i) => <li key={i}>Row {row.row}: {row.value || '(empty)'} — {row.reason}</li>)}</ul></details>}
        </fieldset>

        <fieldset className="builder-step">
          <legend><span className="step-index" aria-hidden="true">2</span>Write the email</legend>
          <label className="form-label">Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} /></label>
          <label className="form-label">Message<textarea ref={bodyRef} rows={10} value={body} onChange={(e) => setBody(e.target.value)} /><small>Write normally — line breaks and links are kept. Click a field below to personalise.</small></label>
          <div className="field-panel inline-fields">
            <h3>Personalise with</h3>
            <div className="field-list">{fields.map((field) => <button key={field} type="button" className="field-chip" onClick={() => insertField(field)}>{`{{${field}}}`}</button>)}</div>
          </div>
          {missing.length > 0 && <div className="missing-warning">Some people have no value for {missing.map((f) => `{{${f}}}`).join(', ')} — that part will be left blank for them.</div>}
        </fieldset>

        <fieldset className="builder-step">
          <legend><span className="step-index" aria-hidden="true">3</span>Sending speed</legend>
          <div className="settings-grid">
            <label className="form-label">Seconds between emails<input type="number" min="2" max="120" value={delaySeconds} onChange={(e) => setDelaySeconds(e.target.value)} /><small>A short gap looks natural and keeps your account safe.</small></label>
            <label className="form-label">Most emails per 24 hours<input type="number" min="1" max="10000" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} /><small>Gmail: keep under 500. Google Workspace: under 2000.</small></label>
          </div>
          {estimate && <p className="muted-copy">{recipientCount > Number(dailyLimit) ? `First ${dailyLimit} emails take ${estimate}; the rest continue automatically after 24 hours.` : `Sending all ${recipientCount} emails takes ${estimate}.`}</p>}
        </fieldset>

        <div className="button-row">
          <button type="button" className="secondary-btn" onClick={sendTest} disabled={busy || !sender?.ready}>Send a test to me</button>
          <button type="button" className="secondary-btn" onClick={() => createCampaign(false)} disabled={busy || !recipientCount || !name.trim()}>Save as draft</button>
          <button type="button" className="primary-btn" onClick={() => createCampaign(true)} disabled={busy || !recipientCount || !name.trim() || !sender?.ready}><Icon name="send" size={16} /> Start sending</button>
        </div>
      </section>

      <section className="panel preview-panel">
        <div className="panel-header"><div><p className="eyebrow">Preview</p><h2>How it will look</h2></div>
          {previews.length > 1 && <div className="button-row">{previews.map((p, i) => <button key={p.email} type="button" className={i === previewIndex ? 'primary-btn' : 'secondary-btn'} onClick={() => setPreviewIndex(i)}>{i + 1}</button>)}</div>}
        </div>
        {preview ? <>
          <p className="muted-copy"><strong>To:</strong> {preview.email}<br /><strong>Subject:</strong> {preview.subject}</p>
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', minHeight: 360, border: '1px solid var(--border, #ddd)', borderRadius: 8, background: '#fff' }} />
        </> : <p className="muted-copy">Write a subject and message to see a preview.</p>}
      </section>
    </div>

    <section className="panel queue-panel">
      <div className="panel-header">
        <div><h2>Your email campaigns</h2><span className="file-note">{campaigns.length} campaigns</span></div>
        {selected && <div className="button-row">
          <button className="secondary-btn" onClick={() => control('start')} disabled={busy || selected.status !== 'draft' || !sender?.ready}>Start</button>
          <button className="secondary-btn" onClick={() => control('pause')} disabled={busy || selected.status !== 'running'}>Pause</button>
          <button className="secondary-btn" onClick={() => control('resume')} disabled={busy || selected.status !== 'paused'}>Resume</button>
          <button className="secondary-btn" onClick={() => control('retry-failed')} disabled={busy || !(selected.failed > 0) || selected.status === 'running'}>Retry failed ({selected.failed || 0})</button>
          <button className="danger-btn" onClick={() => control('stop')} disabled={busy || !['running', 'paused', 'draft'].includes(selected.status)}>Stop</button>
          <button className="danger-btn" onClick={() => control('delete')} disabled={busy || selected.status === 'running'}>Delete</button>
        </div>}
      </div>
      {selected?.last_error && <div className={`notice ${selected.status === 'running' ? 'info' : 'warning'}`} role="status">{selected.last_error}</div>}
      <div className="campaign-table-wrap">
        <table>
          <thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th>Sent</th><th>Failed</th><th>Skipped</th></tr></thead>
          <tbody>{campaigns.map((c) => <tr key={c.id} className={selectedId === c.id ? 'selected-row' : ''} onClick={() => setSelectedId(c.id)}>
            <td data-label="Campaign"><strong>{c.name}</strong><small>{c.subject}</small><small>Created {new Date(c.created_at).toLocaleString()}</small></td>
            <td data-label="Status"><span className={statusClass(c.status)}>{STATUS_TEXT[c.status] || c.status}</span>{c.status === 'running' && remainingOf(c) > 0 && <small>{remainingOf(c)} left</small>}</td>
            <td data-label="Progress">{(c.sent || 0) + (c.failed || 0) + (c.skipped || 0)} / {c.total}</td>
            <td data-label="Sent">{c.sent || 0}</td>
            <td data-label="Failed">{c.failed || 0}</td>
            <td data-label="Skipped">{c.skipped || 0}</td>
          </tr>)}</tbody>
        </table>
        {!campaigns.length && <EmptyState icon="mail" title="No email campaigns yet" description="Upload your customer list, write one email, and send it to everyone — each person sees their own name." />}
      </div>

      {selected && <div className="campaign-detail">
        <div className="panel-header">
          <div><h3>{selected.name}</h3><span className="file-note">{recipientsView.total} {recipientsView.status ? RECIPIENT_STATUS[recipientsView.status]?.toLowerCase() : 'recipients'}</span></div>
          <div className="lead-filters">{[['', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['pending', 'Waiting'], ['skipped', 'Skipped']].map(([key, label]) => <button key={key || 'all'} type="button" className={recipientsView.status === key ? 'active' : ''} onClick={() => loadRecipients(selected.id, key)}>{label}</button>)}</div>
        </div>
        <div className="campaign-table-wrap">
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Details</th></tr></thead>
            <tbody>{recipientsView.list.map((r) => <tr key={r.id}>
              <td data-label="Email">{r.email}</td>
              <td data-label="Name">{r.name || '—'}</td>
              <td data-label="Status">{RECIPIENT_STATUS[r.status] || r.status}</td>
              <td data-label="Details">{r.status === 'sent' && r.sent_at ? `Sent ${new Date(r.sent_at).toLocaleString()}` : (r.error || '—')}</td>
            </tr>)}</tbody>
          </table>
          {recipientsView.total > recipientsView.list.length && <small className="muted-copy">Showing the first {recipientsView.list.length} of {recipientsView.total}.</small>}
        </div>
      </div>}
    </section>
  </div>
}
