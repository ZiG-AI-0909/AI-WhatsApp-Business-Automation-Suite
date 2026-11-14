import { useState } from 'react'
import Modal from './Modal.jsx'
import Icon from './Icon.jsx'

// "How to use" guide — opened from the Help button in the top bar.
// Plain steps for non-technical users; each section can jump to its page.
const SECTIONS = [
  {
    title: '1. Connect WhatsApp',
    view: 'WhatsApp Connection',
    steps: [
      'Open "WhatsApp connection".',
      'QR code (WhatsApp Web): scan it with WhatsApp on your phone → Settings → Linked devices. Good for small campaigns of up to 50 messages.',
      'WhatsApp Business API: use this when you want to send to more than 50 people.',
    ],
  },
  {
    title: '2. Send a WhatsApp campaign',
    view: 'Campaigns',
    steps: [
      'Open "Campaigns" and give the campaign a name.',
      'Upload an Excel file with a "Phone" column. Other columns (Name, City…) can be used in the message.',
      'Write your message. Click a field like {{name}} to add each person\'s name.',
      'Choose Start now, Add to queue, or a schedule, then create the campaign.',
      'Watch progress in the campaign list. You can Pause, Resume, Stop or Retry failed at any time.',
    ],
  },
  {
    title: '3. Send a bulk email',
    view: 'Email Campaigns',
    steps: [
      { text: 'One time: turn on 2-Step Verification for your Google account.', link: 'https://myaccount.google.com/signinoptions/twosv', label: 'Turn on 2-Step Verification' },
      { text: 'Create a Gmail App Password.', link: 'https://myaccount.google.com/apppasswords', label: 'Create App Password' },
      'In Settings → Email, enter your Gmail address and the App Password, save, and press "Test email account".',
      'Open "Email campaigns". Upload an Excel/CSV file with an "Email" column, or paste addresses.',
      'Write the subject and message, add pictures if you like, check the preview, and press "Send a test to me".',
      'Press "Start sending". Free Gmail sends about 500 a day — bigger lists continue by themselves the next day.',
    ],
  },
  {
    title: '4. Contacts, templates and replies',
    view: 'Contacts',
    steps: [
      'Contacts: everyone you have messaged, saved automatically.',
      'Templates: save messages you send often and reuse them.',
      'Inbox: read and answer customer replies. The Knowledge base helps the AI answer common questions.',
    ],
  },
  {
    title: '5. Subscription',
    steps: [
      'Some accounts pay a monthly subscription. When it is due, a "Pay now" message appears at the top.',
      'Pay with UPI, card or netbanking. Each payment adds one month, and everything starts working again right away.',
    ],
  },
]

export default function HelpGuide({ onNavigate, className = 'secondary-btn' }) {
  const [open, setOpen] = useState(false)
  const go = (view) => { setOpen(false); onNavigate?.(view) }
  return <>
    <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog"><Icon name="info" size={16} /> Help</button>
    {open && <Modal onClose={() => setOpen(false)} labelledBy="help-guide-title">
      <div className="panel-header"><div><p className="eyebrow">Help</p><h2 id="help-guide-title">How to use the automation</h2></div><button type="button" className="secondary-btn" onClick={() => setOpen(false)}>Close</button></div>
      <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        {SECTIONS.map((section) => <section key={section.title} style={{ marginBottom: 20 }}>
          <h3>{section.title}</h3>
          <ol>{section.steps.map((step) => typeof step === 'string'
            ? <li key={step} style={{ marginBottom: 6 }}>{step}</li>
            : <li key={step.text} style={{ marginBottom: 6 }}>{step.text} <a href={step.link} target="_blank" rel="noreferrer">{step.label} ↗</a></li>)}</ol>
          {section.view && <button type="button" className="secondary-btn" onClick={() => go(section.view)}>Open {section.view.toLowerCase()}</button>}
        </section>)}
      </div>
    </Modal>}
  </>
}
