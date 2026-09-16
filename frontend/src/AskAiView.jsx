import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'

// Ask AI — conversational assistant for employees. A chat that helps with
// TWO things: how to use this platform, and company profile facts.
// Fully SEPARATE from the Knowledge Base: grounding comes from built-in
// guides on the server (with the company website as a fallback for
// company questions the guides don't cover). The server is stateless:
// the recent conversation is replayed with every message so follow-ups
// like "how about bulk sends?" keep their context.

// Shown as one-click starters when the chat is empty.
const SUGGESTIONS = [
  'How do I schedule a campaign?',
  'What is the combined manufacturing capacity?',
  'How do I connect WhatsApp?',
  'What can Document Intelligence extract?',
]

// Very small in-memory thread (this session only) so a refresh starts a
// clean chat. Each entry: { role: 'user'|'assistant', content, sources? }.
const MAX_THREAD = 40

export default function AskAiView() {
  const [thread, setThread] = useState([])          // chat bubbles
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState([])
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [thread, busy])

  const loadHistory = async () => {
    try { setHistory(await apiFetch('/ask-ai/history')) } catch { /* non-fatal */ }
  }

  const send = async (text) => {
    const message = String(text ?? input).trim()
    if (!message || busy) return
    setBusy(true)
    setNotice('')
    const userBubble = { role: 'user', content: message }
    const outbound = [...thread, userBubble].slice(-MAX_THREAD)
    setThread([...outbound, { role: 'assistant', content: '', pending: true }])
    setInput('')
    try {
      // Replay the clean conversation (no sources/flags) for context.
      const history = outbound.map(({ role, content }) => ({ role, content }))
      const reply = await apiFetch('/ask-ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
      })
      setThread((current) => [...current.slice(0, -1), {
        role: 'assistant',
        content: reply.answer,
        sources: reply.sources || [],
        storedId: reply.id,
      }])
      loadHistory()
    } catch (error) {
      // Remove the pending bubble and surface the error in the thread.
      setThread((current) => current.filter((b) => !b.pending))
      setNotice(friendlyErrorMessage(error, { context: 'Ask AI' }))
    } finally {
      setBusy(false)
    }
  }

  const clearChat = () => {
    if (thread.length && !window.confirm('Clear this conversation? (Saved history is unaffected.)')) return
    setThread([])
    setNotice('')
  }

  const remove = async (id) => {
    try {
      await apiFetch(`/ask-ai/history/${id}`, { method: 'DELETE' })
      await loadHistory()
    } catch (error) {
      setNotice(friendlyErrorMessage(error, { context: 'Ask AI · history' }))
    }
  }

  const openHistory = async () => {
    setShowHistory((v) => !v)
    if (!showHistory) loadHistory()
  }

  return (
    <div className="view-workspace">
      <div className="chat-heading">
        <div>
          <p className="eyebrow">Assistant</p>
          <h2>Ask AI</h2>
          <p className="muted-copy">Chat with your internal assistant — how to use this platform, or company profile questions. Built-in guides only: this is separate from the Knowledge Base and never messages customers.</p>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-btn" onClick={openHistory}>{showHistory ? 'Hide history' : 'History'}</button>
          <button type="button" className="secondary-btn" onClick={clearChat} disabled={!thread.length}>Clear chat</button>
        </div>
      </div>

      {notice && <div className="notice error">{notice}</div>}

      <section className="panel chat-panel">
        <div className="chat-scroll">
          {!thread.length && (
            <div className="chat-empty">
              <p>👋 Hi! I can help you use this platform or answer company profile questions. Try one of these:</p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chat-suggestion" onClick={() => send(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {thread.map((bubble, index) => (
            bubble.role === 'user' ? (
              <div className="chat-row chat-row-user" key={index}>
                <div className="chat-bubble chat-bubble-user">{bubble.content}</div>
              </div>
            ) : (
              <div className="chat-row chat-row-assistant" key={index}>
                <div className="chat-bubble chat-bubble-assistant">
                  {bubble.pending
                    ? <span className="chat-typing">Thinking…</span>
                    : (
                      <>
                        <span className="chat-text">{bubble.content}</span>
                        {bubble.sources?.length > 0 && (
                          <div className="chat-sources">
                            {bubble.sources.map((s, i) => <span className="tag" key={`${s.id}-${i}`}>📄 {s.name}</span>)}
                          </div>
                        )}
                      </>
                    )}
                </div>
              </div>
            )
          ))}
          <div ref={endRef} />
        </div>

        <form
          className="chat-input-row"
          onSubmit={(event) => { event.preventDefault(); send() }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={busy ? 'The assistant is replying…' : 'Ask how to use the platform, or about the company…'}
            disabled={busy}
            aria-label="Message the assistant"
          />
          <button type="submit" className="primary-btn" disabled={busy || !input.trim()}>Send</button>
        </form>
        <small className="help-note">Answers come from the assistant's built-in guides (platform how-to + company profile), with the company website as a fallback. Separate from your Knowledge Base, which powers the customer WhatsApp auto-reply.</small>
      </section>

      {showHistory && (
        <section className="panel">
          <div className="panel-header">
            <h2>Question history</h2>
            <span className="file-note">{history.length} saved</span>
          </div>
          <div className="campaign-table-wrap">
            <table>
              <thead>
                <tr><th>Question</th><th>Answer</th><th>Sources</th><th>Asked</th><th /></tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Question"><strong>{item.question}</strong></td>
                    <td data-label="Answer"><small>{item.answer}</small></td>
                    <td data-label="Sources"><small>{(item.source_doc_names || []).join(', ') || '-'}</small></td>
                    <td data-label="Asked"><small>{item.created_at ? new Date(item.created_at).toLocaleString() : ''}</small></td>
                    <td data-label="Actions">
                      <div className="button-row">
                        <button type="button" className="secondary-btn" onClick={() => send(item.question)}>Re-ask</button>
                        <button type="button" className="danger-btn" onClick={() => remove(item.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!history.length && <p className="muted-copy">No questions saved yet.</p>}
          </div>
        </section>
      )}
    </div>
  )
}
