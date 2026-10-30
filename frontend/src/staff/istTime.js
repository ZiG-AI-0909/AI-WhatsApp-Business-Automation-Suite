// Dates and times on the staff dashboard — always India time (Asia/Kolkata).

// Month names spelled out here: some browsers print "Sept" for en-GB.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const IST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
})

/** ISO timestamp → "30 Oct 2026, 12:41 PM" (Asia/Kolkata). */
export function formatIst(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  const part = Object.fromEntries(IST_PARTS.formatToParts(date).map(({ type, value: text }) => [type, text]))
  return `${part.day} ${MONTHS[Number(part.month) - 1]} ${part.year}, ${part.hour}:${part.minute} ${String(part.dayPeriod || '').toUpperCase()}`
}
