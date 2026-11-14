import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../api.js'
import { friendlyErrorMessage } from '../utils/errorMessages.js'
import Icon from '../components/Icon.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Monthly subscription (Razorpay).
//   PayScreen         — shown instead of the automation pages when a ticked
//                       account has not paid this month.
//   SubscriptionsView — super admins tick who must pay and set each price.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYMENT_REQUIRED_EVENT = 'app:payment-required'

const rupees = (amount) => `₹${Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

let checkoutPromise = null
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve()
  checkoutPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload = () => resolve()
    script.onerror = () => { checkoutPromise = null; reject(new Error('The payment window could not be loaded. Check your internet connection and try again.')) }
    document.body.appendChild(script)
  })
  return checkoutPromise
}

/** Opens Razorpay Checkout for one month; resolves with the new status. */
export async function payOneMonth({ businessName }) {
  await loadCheckout()
  const order = await apiFetch('/billing/order', { method: 'POST' })
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: businessName || 'Monthly subscription',
      description: 'Automation — 1 month',
      prefill: { email: order.email },
      theme: { color: '#1f6feb' },
      handler: async (response) => {
        try {
          resolve(await apiFetch('/billing/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) }))
        } catch (error) { reject(error) }
      },
      modal: { ondismiss: () => reject(Object.assign(new Error('Payment was cancelled.'), { cancelled: true })) },
    })
    checkout.on('payment.failed', (event) => reject(new Error(event?.error?.description || 'The payment did not go through. No money was taken — please try again.')))
    checkout.open()
  })
}

export function SubscriptionBanner({ billing, onPay }) {
  if (!billing?.required) return null
  if (billing.blocked) {
    return <div className="notice warning" role="status"><strong>Your monthly subscription is due.</strong> Pay {rupees(billing.amount)} to keep using WhatsApp, campaigns and email automation. <button type="button" onClick={onPay}>Pay now</button></div>
  }
  const daysLeft = billing.paidUntil ? Math.ceil((new Date(billing.paidUntil) - Date.now()) / 864e5) : null
  if (daysLeft !== null && daysLeft <= 3) {
    return <div className="notice info" role="status">Your subscription renews on {day(billing.paidUntil)}. Pay {rupees(billing.amount)} early so nothing stops. <button type="button" onClick={onPay}>Pay now</button></div>
  }
  return null
}

export function PayScreen({ billing, onPaid, businessName }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const pay = async () => {
    setBusy(true); setNotice({ type: '', text: '' })
    try {
      const status = await payOneMonth({ businessName })
      setNotice({ type: 'success', text: `Payment received — thank you! Active until ${day(status.paidUntil)}.` })
      onPaid?.(status)
    } catch (error) {
      if (!error.cancelled) setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Payment' }) })
    } finally { setBusy(false) }
  }
  return <section className="panel empty-state-panel" aria-labelledby="pay-title">
    <Icon name="lock" size={32} />
    <h2 id="pay-title">Subscription due</h2>
    <p className="muted-copy">The automation (WhatsApp, campaigns, email campaigns) is paused for your account until this month's subscription is paid. Your contacts and campaigns are safe.</p>
    <p><strong style={{ fontSize: '1.6rem' }}>{rupees(billing.amount)}</strong> <span className="muted-copy">/ month</span></p>
    {billing.paidUntil && <p className="muted-copy">Your last subscription ended on {day(billing.paidUntil)}.</p>}
    {notice.text && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
    {billing.canPayOnline
      ? <button type="button" className="primary-btn" onClick={pay} disabled={busy}>{busy ? 'Opening payment…' : `Pay ${rupees(billing.amount)} with UPI / card`}</button>
      : <p className="muted-copy">Online payment is not switched on yet. Please contact your administrator to pay.</p>}
    <small className="muted-copy">Payments are handled securely by Razorpay. Each payment adds one month.</small>
  </section>
}

export function SubscriptionsView() {
  const [data, setData] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState({ type: '', text: '' })

  const load = useCallback(async () => {
    try {
      const result = await apiFetch('/billing/accounts')
      setData(result)
      setDrafts(Object.fromEntries(result.accounts.map((a) => [a.user_id, { required: a.required, amount: a.amount ? String(a.amount) : '' }])))
    } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Loading subscriptions' }) }) }
  }, [])
  useEffect(() => { load() }, [load])

  const setDraft = (id, patch) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }))

  const save = async (account) => {
    const draft = drafts[account.user_id]
    setBusyId(account.user_id); setNotice({ type: '', text: '' })
    try {
      await apiFetch(`/billing/accounts/${account.user_id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ required: draft.required, amount: Number(draft.amount) || 0 }) })
      setNotice({ type: 'success', text: draft.required ? `${account.email} now pays ${rupees(draft.amount)} a month.` : `${account.email} is now free.` })
      await load()
    } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Saving subscription' }) }) } finally { setBusyId(null) }
  }

  const markPaid = async (account) => {
    if (!window.confirm(`Record a cash / bank payment from ${account.email} and add 1 month?`)) return
    setBusyId(account.user_id); setNotice({ type: '', text: '' })
    try {
      await apiFetch(`/billing/accounts/${account.user_id}/mark-paid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ months: 1 }) })
      setNotice({ type: 'success', text: `One month added for ${account.email}.` })
      await load()
    } catch (error) { setNotice({ type: 'error', text: friendlyErrorMessage(error, { context: 'Marking as paid' }) }) } finally { setBusyId(null) }
  }

  if (!data) return <div className="view-workspace">{notice.text ? <div className={`notice ${notice.type}`}>{notice.text}</div> : <p className="muted-copy">Loading accounts…</p>}</div>

  const q = query.trim().toLowerCase()
  const rows = data.accounts
    .filter((a) => !q || String(a.email).toLowerCase().includes(q))
    .filter((a) => filter === 'all' || (filter === 'paying' ? a.required : filter === 'unpaid' ? a.required && !a.paid : !a.required))
  const counts = { paying: data.accounts.filter((a) => a.required).length, unpaid: data.accounts.filter((a) => a.required && !a.paid).length }

  return <div className="view-workspace">
    <div>
      <p className="eyebrow">Setup</p>
      <h2>Subscriptions</h2>
      <p className="muted-copy">Tick the accounts that must pay a monthly subscription and set their price. Until they pay, their WhatsApp, campaign and email automation is paused. Everyone else stays free.</p>
    </div>
    {!data.canPayOnline && <div className="notice warning">Online payment is off: add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the server settings. You can still use "Mark paid" for cash or bank payments.</div>}
    {notice.text && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
    <section className="panel">
      <div className="panel-header">
        <div className="lead-filters">{[['all', `All (${data.accounts.length})`], ['paying', `Must pay (${counts.paying})`], ['unpaid', `Unpaid (${counts.unpaid})`], ['free', 'Free']].map(([key, label]) => <button key={key} type="button" className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div>
        <input type="search" placeholder="Search email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search accounts by email" />
      </div>
      <div className="campaign-table-wrap">
        <table>
          <thead><tr><th>Must pay</th><th>Account</th><th>Monthly price (₹)</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.map((a) => {
            const draft = drafts[a.user_id] || { required: false, amount: '' }
            const changed = draft.required !== a.required || (Number(draft.amount) || 0) !== a.amount
            return <tr key={a.user_id}>
              <td data-label="Must pay"><input type="checkbox" aria-label={`${a.email} must pay`} checked={draft.required} disabled={a.super_admin} onChange={(e) => setDraft(a.user_id, { required: e.target.checked })} /></td>
              <td data-label="Account"><strong>{a.email}</strong>{a.super_admin && <small>Super admin — never pays</small>}</td>
              <td data-label="Monthly price (₹)"><input type="number" min="1" step="1" inputMode="decimal" style={{ maxWidth: 120 }} value={draft.amount} placeholder="999" disabled={!draft.required} onChange={(e) => setDraft(a.user_id, { amount: e.target.value })} /></td>
              <td data-label="Status">{!a.required ? <span className="campaign-status stopped">Free</span> : a.paid ? <span className="campaign-status running">Paid until {day(a.paid_until)}</span> : <span className="campaign-status failed">Unpaid{a.paid_until ? ` since ${day(a.paid_until)}` : ''}</span>}</td>
              <td data-label="Actions"><div className="button-row">
                <button type="button" className="primary-btn" disabled={!changed || busyId === a.user_id || (draft.required && !(Number(draft.amount) >= 1))} onClick={() => save(a)}>Save</button>
                {a.required && <button type="button" className="secondary-btn" disabled={busyId === a.user_id} onClick={() => markPaid(a)}>Mark paid (1 month)</button>}
              </div></td>
            </tr>
          })}</tbody>
        </table>
        {!rows.length && <p className="muted-copy">No accounts match.</p>}
      </div>
    </section>
  </div>
}
