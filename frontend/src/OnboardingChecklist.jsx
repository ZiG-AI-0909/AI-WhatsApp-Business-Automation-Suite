import { useEffect, useState } from 'react'
import { apiFetch } from './api.js'

// ─────────────────────────────────────────────────────────────────────────────
// In-app onboarding checklist for the Dashboard.
//
// Completion status is derived from real account data — no new database
// fields:
//   1. WhatsApp connected        → passed down from App's existing status poll
//   2. Knowledge Base has docs   → /knowledge (fetched here, on mount)
//   3. Contacts exist            → App's existing /analytics/dashboard poll
//   4. A message has been sent   → outbound message + campaign sent counts
//                                  from the same dashboard payload
//
// App re-renders this component every time its 10s dashboard poll updates,
// so step completion refreshes live as the user completes steps.
//
// Persisted state is only the manual dismiss and the collapsed "Setup
// complete" state (both localStorage keys).
// ─────────────────────────────────────────────────────────────────────────────

const DISMISS_KEY = 'onboarding:dismissed'
const COMPLETE_KEY = 'onboarding:completed-dismissed'

const readFlag = (key) => {
  try { return window.localStorage.getItem(key) === 'true' } catch { return false }
}
const writeFlag = (key, value) => {
  try {
    if (value) window.localStorage.setItem(key, 'true')
    else window.localStorage.removeItem(key)
  } catch { /* private mode etc. — dismiss just won't persist */ }
}

function StepRow({ index, step, onNavigate }) {
  return (
    <li className={`onboarding-step ${step.done ? 'done' : ''}`}>
      <span className="onboarding-step-check" aria-hidden="true">{step.done ? '✓' : ''}</span>
      <div className="onboarding-step-body">
        <strong>{step.title}</strong>
        <small>{step.description}</small>
      </div>
      {!step.done && step.target && (
        <button
          type="button"
          className="secondary-btn onboarding-step-action"
          onClick={() => onNavigate(step.target)}
        >
          {step.actionLabel}
        </button>
      )}
      {step.done && <span className="onboarding-step-state">Done</span>}
      <span className="visually-hidden">{`Step ${index + 1} of 4`}</span>
    </li>
  )
}

export default function OnboardingChecklist({ onNavigate, dashboard, whatsappConnected }) {
  const [dismissed, setDismissed] = useState(() => readFlag(DISMISS_KEY))
  const [completeDismissed, setCompleteDismissed] = useState(() => readFlag(COMPLETE_KEY))
  const [knowledgeCount, setKnowledgeCount] = useState(null)

  // Knowledge document count is the only value App doesn't already poll.
  // Fetched once on mount; the component remounts whenever the user switches
  // back to the Dashboard, so returning from the Knowledge Base re-checks it.
  useEffect(() => {
    let cancelled = false
    apiFetch('/knowledge')
      .then((documents) => { if (!cancelled) setKnowledgeCount(Array.isArray(documents) ? documents.length : 0) })
      .catch(() => { if (!cancelled) setKnowledgeCount(0) })
    return () => { cancelled = true }
  }, [])

  // dashboard is guaranteed non-null here: the Dashboard view only renders
  // after App's analytics poll resolves.
  const contactCount = Number(dashboard?.contacts?.total ?? 0) || 0
  const outboundCount =
    (Number(dashboard?.messages?.outbound ?? 0) || 0) +
    (Number(dashboard?.campaigns?.total_sent ?? 0) || 0)

  const steps = [
    {
      title: 'Connect your WhatsApp',
      description: 'Scan the QR code or connect the Business API to start messaging.',
      done: Boolean(whatsappConnected),
      target: 'WhatsApp Connection',
      actionLabel: 'Connect',
    },
    {
      title: 'Review your Knowledge Base',
      description: 'Add your business info and documents so the AI answers accurately.',
      done: (knowledgeCount ?? 0) > 0,
      target: 'Knowledge Base',
      actionLabel: 'Open Knowledge Base',
    },
    {
      title: 'Add your first contact',
      description: 'Import a list or add a customer manually to start building your directory.',
      done: contactCount > 0,
      target: 'Contacts',
      actionLabel: 'Add contact',
    },
    {
      title: 'Send your first message or campaign',
      description: 'Message a customer from the Inbox or launch a bulk campaign.',
      done: outboundCount > 0,
      target: 'Campaigns',
      actionLabel: 'Open Campaigns',
    },
  ]

  const doneCount = steps.filter((step) => step.done).length
  const allDone = doneCount === steps.length

  if (dismissed) return null
  // All 4 complete and the user already hid the celebration banner → gone.
  if (allDone && completeDismissed) return null

  const dismiss = () => {
    if (allDone) {
      writeFlag(COMPLETE_KEY, true)
      setCompleteDismissed(true)
    } else {
      writeFlag(DISMISS_KEY, true)
      setDismissed(true)
    }
  }

  return (
    <section className={`panel onboarding-checklist ${allDone ? 'complete' : ''}`} aria-label="Getting started checklist">
      <div className="onboarding-header">
        <div>
          <p className="eyebrow">{allDone ? 'All set' : 'Getting started'}</p>
          <h2>{allDone ? '🎉 Setup complete' : 'Set up your workspace'}</h2>
          <p className="muted-copy">
            {allDone
              ? 'You are ready to go — your WhatsApp connection, knowledge base, contacts, and messaging are all configured.'
              : `${doneCount} of ${steps.length} steps complete — finish these to get the most out of your assistant.`}
          </p>
        </div>
        <div className="onboarding-header-actions">
          {!allDone && (
            <span className="onboarding-progress" role="img" aria-label={`${doneCount} of ${steps.length} steps complete`}>
              <i style={{ width: `${(doneCount / steps.length) * 100}%` }} />
            </span>
          )}
          <button type="button" className="secondary-btn onboarding-dismiss" onClick={dismiss} aria-label="Dismiss the setup checklist">
            {allDone ? 'Hide' : 'Dismiss'}
          </button>
        </div>
      </div>

      {allDone ? (
        <p className="onboarding-complete-copy">
          Everything is configured. You can revisit any section from the sidebar — for example,
          pause or resume the AI per conversation in the Inbox at any time.
        </p>
      ) : (
        <ol className="onboarding-steps">
          {steps.map((step, index) => (
            <StepRow key={step.title} index={index} step={step} onNavigate={onNavigate} />
          ))}
        </ol>
      )}
    </section>
  )
}
