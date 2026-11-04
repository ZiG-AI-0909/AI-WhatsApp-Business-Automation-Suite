/**
 * Link target for a website address that came from outside the app (text an
 * AI read off an image, say). Only http(s) is ever returned, so a
 * "javascript:" value cannot become a clickable link, and a bare
 * "www.example.com" opens that site, not a path inside this app.
 * Returns '' when the value cannot be linked.
 */
export function safeHref(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]+:\d+(\/|$)/.test(text)
  try {
    const url = new URL(hasScheme ? text : `https://${text.replace(/^\/+/, '')}`)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.') ? url.href : ''
  } catch {
    return ''
  }
}
