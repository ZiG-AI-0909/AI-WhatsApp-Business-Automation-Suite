import { useEffect, useState } from 'react'
import { apiFetch } from '../api.js'
import { friendlyErrorMessage } from '../utils/errorMessages.js'
import Icon from './Icon.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Per-page settings: a "⚙ Settings" button at the top of each automation page
// that opens only the settings that page uses. Saves to the same place as
// the main Settings page (PUT /api/settings), so both always agree.
// ─────────────────────────────────────────────────────────────────────────────

const BREVO_STEPS = <p className="muted-copy">Free through Brevo (300 emails a day): <a href="https://onboarding.brevo.com/account/register" target="_blank" rel="noreferrer">create a free account ↗</a>, <a href="https://app.brevo.com/senders/list" target="_blank" rel="noreferrer">verify your sender email ↗</a>, then <a href="https://app.brevo.com/settings/keys/api" target="_blank" rel="noreferrer">create an API key ↗</a> and paste it below.</p>

const GROUPS = {
  email: {
    title: 'Email account',
    intro: BREVO_STEPS,
    status: (s) => (s.emailSending?.ready ? 'Connected' : 'Not set up'),
    ok: (s) => Boolean(s.emailSending?.ready),
    fields: [
      { key: 'brevoApiKey', label: 'Brevo API key', secret: true, placeholder: 'xkeysib-...', isSet: (s) => s.emailSending?.brevo?.keySet },
      { key: 'smtpUser', label: 'Sender email (verified in Brevo)', type: 'email', placeholder: 'you@yourbusiness.com', read: (s) => s.emailSending?.smtp?.user },
      { key: 'smtpFromName', label: 'Sender name', placeholder: 'Your Business Name', read: (s) => s.emailSending?.smtp?.fromName },
    ],
    test: { label: 'Save & send test email', path: '/settings/email/smtp-test' },
  },
  ai: {
    title: 'AI assistant',
    intro: <p className="muted-copy">The AI writes replies, answers questions and reads documents. Paste the API key from your AI provider.</p>,
    status: (s) => (s.ai?.available ? 'Available' : 'Not set up'),
    ok: (s) => Boolean(s.ai?.available),
    fields: [
      { key: 'aiApiKey', label: 'API key', secret: true, placeholder: 'Leave blank to keep the current key', isSet: () => false },
      { key: 'aiBaseURL', label: 'Base URL', read: (s) => s.ai?.baseURL },
      { key: 'aiModel', label: 'Model', read: (s) => s.ai?.model },
    ],
  },
  country: {
    title: 'Phone numbers',
    intro: <p className="muted-copy">Numbers in your Excel files without a country code get this code added.</p>,
    fields: [
      { key: 'defaultCountryCode', label: 'Default country code', select: true, read: (s) => s.defaultCountryCode },
    ],
  },
}

// Which settings each page shows.
export const PAGE_SETTINGS = {
  'Email Campaigns': ['email'],
  Campaigns: ['country'],
  Contacts: ['country'],
  Inbox: ['ai'],
  'Knowledge Base': ['ai'],
  'Ask AI': ['ai'],
}

export default function PageSettings({ view }) {
  const groups = (PAGE_SETTINGS[view] || []).map((key) => GROUPS[key])
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(null)
  const [form, setForm] = useState({})
  const [show, setShow] = useState({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })

  const fill = (s) => {
    const next = {}
    for (const group of groups) for (const field of group.fields) next[field.key] = field.secret ? '' : String(field.read?.(s) ?? '')
    setForm(next)
  }

  useEffect(() => {
    if (!open || settings) return
    apiFetch('/settings').then((s) => { setSettings(s); fill(s) }).catch((error) => setNotice({ type: 'error', text: friendlyErrorMessage(error) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!groups.length) return null

  const save = async (testPath) => {
    setBusy(true); setNotice({ type: '', text: '' })
    try {
      const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v || '').trim()]).filter(([, v]) => v))
      const updated = await apiFetch('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      setSettings(updated); fill(updated); setShow({})
      if (testPath) {
        const result = await apiFetch(testPath, { method: 'POST' })
        setNotice({ type: 'success', text: result.message || 'Test sent.' })
      } else {
        setNotice({ type: 'success', text: 'Settings saved.' })
      }
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: testPath ? 'Test' : 'Saving settings' }) })
    } finally { setBusy(false) }
  }

  return <div className="page-settings">
    <div className="button-row" style={{ justifyContent: 'flex-end' }}>
      <button type="button" className="secondary-btn" onClick={() => setOpen(!open)} aria-expanded={open}><Icon name="sliders" size={16} /> {open ? 'Close settings' : 'Settings'}</button>
    </div>
    {open && <section className="panel settings-panel" aria-label={`${view} settings`}>
      {!settings ? (notice.text ? <div className={`notice ${notice.type}`}>{notice.text}</div> : <p className="muted-copy">Loading settings…</p>) : <>
        {groups.map((group) => <div key={group.title}>
          <div className="panel-header"><h2>{group.title}</h2>{group.status && <span className={`campaign-status ${group.ok(settings) ? 'running' : 'stopped'}`}>{group.status(settings)}</span>}</div>
          {group.intro}
          <div className="settings-grid">
            {group.fields.map((field) => <label className="form-label" key={field.key}>{field.label}
              {field.select
                ? <select value={form[field.key] || ''} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} className="country-select">{(settings.countries || []).map((c) => <option key={`${c.name}-${c.dialCode}`} value={c.dialCode}>{c.name} (+{c.dialCode})</option>)}</select>
                : field.secret
                  ? <div className="input-with-action"><input type={show[field.key] ? 'text' : 'password'} value={form[field.key] || ''} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} placeholder={field.isSet?.(settings) ? 'Leave blank to keep the current one' : field.placeholder} autoComplete="new-password" /><button type="button" className="secondary-btn" onClick={() => setShow({ ...show, [field.key]: !show[field.key] })}>{show[field.key] ? 'Hide' : 'Show'}</button></div>
                  : <input type={field.type || 'text'} value={form[field.key] || ''} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} placeholder={field.placeholder} />}
            </label>)}
          </div>
        </div>)}
        {notice.text && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
        <div className="button-row">
          <button type="button" className="primary-btn" onClick={() => save(null)} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {groups.filter((g) => g.test).map((g) => <button key={g.test.path} type="button" className="secondary-btn" onClick={() => save(g.test.path)} disabled={busy}>{g.test.label}</button>)}
        </div>
      </>}
    </section>}
  </div>
}
