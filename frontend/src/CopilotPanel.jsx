import { useState } from 'react'
import { apiFetch } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'

// Salesperson Copilot — on-demand brief for one contact/conversation.
// Deliberately a button, not automatic: generation costs one AI call.
// The brief only uses data that exists in this system (contact fields,
// notes/tags, WhatsApp history). Products shown are chat mentions —
// this system has no quotations/deals records, and the panel says so.
export default function CopilotPanel({ contactId = null, conversationId = null, identity = '' }) {
  const [brief, setBrief] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const generate = async () => {
    setBusy(true)
    setNotice('')
    try {
      setBrief(await apiFetch('/copilot/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, conversationId }),
      }))
    } catch (error) {
      setNotice(friendlyErrorMessage(error, { context: 'Copilot brief' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel copilot-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Salesperson Copilot</p>
          <h2>Brief me{identity ? ` on ${identity}` : ''}</h2>
        </div>
        <button type="button" className="primary-btn" onClick={generate} disabled={busy}>
          {busy ? 'Preparing brief…' : brief ? 'Regenerate brief' : 'Generate brief'}
        </button>
      </div>

      {notice && <div className="notice error">{notice}</div>}

      {brief && (
        <>
          {brief.ai_summary && (
            <div className="copilot-section">
              <h4>Quick brief (AI)</h4>
              <p>{brief.ai_summary}</p>
            </div>
          )}

          <div className="copilot-section">
            <h4>Conversation so far</h4>
            <p>{brief.conversation_summary}</p>
            <small className="muted-copy">
              {brief.conversation_stats.total_messages} messages · {brief.conversation_stats.inbound} in / {brief.conversation_stats.outbound} out
              {brief.conversation_stats.waiting_on_customer ? ' · waiting on the customer' : ' · their last message needs your reply'}
            </small>
          </div>

          <div className="copilot-section">
            <h4>Notes & tags</h4>
            {brief.contact.notes ? <p>{brief.contact.notes}</p> : <p className="muted-copy">No notes saved on this contact.</p>}
            {brief.contact.tags?.length > 0 && (
              <div className="button-row">
                {brief.contact.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
              </div>
            )}
          </div>

          <div className="copilot-section">
            <h4>Products mentioned in chat</h4>
            <p>
              {brief.products_discussed_from_chat.length
                ? brief.products_discussed_from_chat.join(', ')
                : 'None yet in the WhatsApp history.'}
            </p>
            <small className="muted-copy">From WhatsApp history only — this system has no quotation records, so nothing here is a confirmed order or quote.</small>
          </div>

          {brief.open_questions_from_customer.length > 0 && (
            <div className="copilot-section">
              <h4>Open questions from the customer</h4>
              <ul>
                {brief.open_questions_from_customer.map((question, index) => <li key={index}>{question}</li>)}
              </ul>
            </div>
          )}

          <div className="copilot-section">
            <h4>Before you reach out</h4>
            <ul>
              {brief.suggested_talking_points.map((point, index) => <li key={index}>{point}</li>)}
            </ul>
          </div>

          <div className="copilot-meta">
            <small className="muted-copy">Sources: {brief.data_sources.join(' · ')}</small>
            <small className="muted-copy">Generated {new Date(brief.generated_at).toLocaleString()}</small>
          </div>
        </>
      )}

      {!brief && !busy && !notice && (
        <p className="muted-copy">Generate a one-screen brief: recent chat summary, saved notes/tags, and what to check before your next interaction. Built only from this contact's real data.</p>
      )}
    </section>
  )
}
