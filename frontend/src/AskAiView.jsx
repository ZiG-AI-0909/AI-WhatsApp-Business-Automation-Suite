import { useEffect, useState } from 'react'
import { apiFetch } from './api.js'
import { friendlyErrorMessage } from './utils/errorMessages.js'
import EmptyState from './components/EmptyState.jsx'

const formatDate = (value) => value ? new Date(value).toLocaleString() : ''

// Ask AI — internal Technical Query Resolver. Type a technical question,
// get an answer generated ONLY from your Knowledge Base documents, with
// the exact source documents cited below the answer.
export default function AskAiView() {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState(null)
  const [history, setHistory] = useState([])
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)

  const loadHistory = async () => {
    try {
      setHistory(await apiFetch('/ask-ai/history'))
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Ask AI' }) })
    }
  }

  useEffect(() => { loadHistory() }, [])

  const ask = async (event) => {
    event.preventDefault()
    if (!question.trim()) return
    setBusy(true)
    setNotice({ type: '', text: '' })
    setResult(null)
    try {
      setResult(await apiFetch('/ask-ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim() }),
      }))
      await loadHistory()
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Ask AI' }) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id) => {
    try {
      await apiFetch(`/ask-ai/history/${id}`, { method: 'DELETE' })
      await loadHistory()
    } catch (error) {
      setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Ask AI · history' }) })
    }
  }

  return (
    <div className="view-workspace">
      <div>
        <p className="eyebrow">Technical search</p>
        <h2>Ask AI</h2>
        <p className="muted-copy">Ask anything — Sudarshan Pipes products, or how to use this platform — and get an answer built from your Knowledge Base, with the source documents it came from. Internal tool: this does not message customers.</p>
      </div>

      {notice.text && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <section className="panel">
        <form className="form-stack" onSubmit={ask}>
          <label className="form-label">
            Your question
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="e.g. What's the pressure class for our 6-inch HDPE pipe?"
              required
            />
          </label>
          <div className="button-row">
            <button type="submit" className="primary-btn" disabled={busy || !question.trim()}>
              {busy ? 'Searching your documents…' : 'Ask AI'}
            </button>
          </div>
          <small className="help-note">Answers come only from your Knowledge Base documents. If nothing matches, add the relevant document in Knowledge Base and ask again.</small>
        </form>
      </section>

      {result && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Answer</p>
              <h2>{result.question}</h2>
            </div>
          </div>
          <p className="ask-answer">{result.answer}</p>
          {result.sources?.length > 0 && (
            <div className="ask-sources">
              <strong>Sources:</strong>
              <div className="button-row">
                {result.sources.map((source) => (
                  <span className="tag" key={source.id}>📄 {source.name}</span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Past questions</h2>
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
                  <td data-label="Asked"><small>{formatDate(item.created_at)}</small></td>
                  <td data-label="Actions">
                    <div className="button-row">
                      <button type="button" className="secondary-btn" onClick={() => setQuestion(item.question)}>Re-ask</button>
                      <button type="button" className="danger-btn" onClick={() => remove(item.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!history.length && (
            <EmptyState
              icon="🔎"
              title="No questions yet"
              description="Ask your first question above — about products or the platform itself — and the answer and its source documents will be saved here so you can revisit them."
            />
          )}
        </div>
      </section>
    </div>
  )
}
