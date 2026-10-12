// ─────────────────────────────────────────────────────────────────────────────
// Human-readable error translation.
//
// Non-technical users should never see raw technical strings (Postgres codes
// like "PGRST123", stack traces, "[object Object]", raw JSON). Everything the
// UI displays goes through friendlyErrorMessage(); full technical detail stays
// in console.error() for debugging.
// ─────────────────────────────────────────────────────────────────────────────

const FRIENDLY = {
  NETWORK: "We're having trouble connecting. Please check your internet and try again.",
  SESSION: 'Your session expired — please sign in again.',
  NOT_FOUND: "We couldn't find that — it may have been deleted.",
  RATE_LIMIT: "You've hit a usage limit. Try again in a bit.",
  SERVER: 'Something went wrong on our end. Please try again shortly.',
  GENERIC: 'Something went wrong. Please try again, or contact support if it continues.',
  AUTH: "We couldn't sign you in. Please check your details and try again.",
  WHATSAPP_QR: 'Connection timed out — refreshing QR code…',
  FILE: 'There was a problem with that file. Please check it and try again.',
}

// Patterns that indicate a network/connectivity failure rather than an app error.
const NETWORK_PATTERNS = [
  'failed to fetch',
  'networkerror',
  'network request failed',
  'load failed',
  'err_internet_disconnected',
  'err_name_not_resolved',
  'err_connection_refused',
  'err_connection_reset',
  'err_connection_timed_out',
  'socket hang up',
  'econnaborted',
  'econnrefused',
  'enotfound',
  'etimedout',
  'timeout', // fetch aborts / gateway timeouts surface as various "timeout" strings
]

// Literal substrings indicating internal/technical detail. Checked with
// includes() so strings like '[object Object]' match verbatim (as regex they'd
// become a character class and match almost anything!).
const TECHNICAL_LITERALS = [
  'pgrst', // PostgREST error codes (PGRST101, PGRST123, …)
  'postgres',
  'sqlstate',
  'pg_',
  'supabase', // "AuthApiError", "supabase returned …", etc.
  'authapierror',
  'invalid api key',
  'jwt',
  'stack trace',
  'typeerror',
  'referenceerror',
  'cannot read propert',
  'is not a function',
  'is not defined',
  'undefined is not',
  'null is not',
  '[object object]',
  'uncaught',
  'internal server error',
  'etimedout',
  'econnrefused',
  'syntax error at or near',
  'duplicate key value',
  'row-level security',
  'permission denied',
  'query failed',
]

// Regex-shaped technical patterns (need real regex semantics).
const TECHNICAL_REGEXES = [
  /relation \w+ does not exist/i,
  /column \w+ does not exist/i,
]

function matchesNetwork(message) {
  const lowered = String(message).toLowerCase()
  return NETWORK_PATTERNS.some((pattern) => lowered.includes(pattern))
}

// True when the string looks like internal/technical detail that should never
// reach a non-technical user (raw codes, stack text, JS errors, JSON dumps).
export function isTechnicalError(message) {
  const text = String(message || '')
  if (!text.trim()) return true
  const lowered = text.toLowerCase()
  if (TECHNICAL_LITERALS.some((pattern) => lowered.includes(pattern))) return true
  if (TECHNICAL_REGEXES.some((pattern) => pattern.test(text))) return true
  // Raw JSON / object dumps
  if (/^[\s]*[{}[\]]/.test(text) && /[:]/.test(text)) return true
  // HTTP-ish raw strings: "Request failed (500)", "HTTP 404", "401 Unauthorized"
  if (/request failed \(|\bhttp \d{3}\b|\b\d{3} (unauthorized|forbidden|not found|bad request|internal server error)/i.test(text)) return true
  return false
}

function detectStatus(message) {
  // Any error explicitly carrying a status (Error.status, ApiError, or text
  // like "Request failed (404)") gets status-based handling.
  if (message instanceof Error && Number.isFinite(message.status)) return message.status
  const text = String(message || '')
  const match = text.match(/request failed \((\d{3})\)|\b(?:http|status)[\s:]+(\d{3})\b/i)
  if (!match) return null
  return Number(match[1] || match[2])
}

function messageForStatus(status) {
  if (status === 401 || status === 403) return FRIENDLY.SESSION
  if (status === 404) return FRIENDLY.NOT_FOUND
  if (status === 408 || status === 504) return FRIENDLY.NETWORK
  if (status === 429) return FRIENDLY.RATE_LIMIT
  if (status >= 500) return FRIENDLY.SERVER
  return null
}

/**
 * Translate any caught error into text safe to show a non-technical user.
 *
 * @param {unknown} error - the caught error (Error instance, string, anything)
 * @param {object} [options]
 * @param {string} [options.fallback] - text used when nothing better applies.
 *   Defaults to the generic "Something went wrong…" message.
 * @param {Array<{match: RegExp|string, message: string}>} [options.custom]
 *   Extra substring/regex → message rules checked before the generic
 *   fallback. Use for actionable provider errors worth keeping specific
 *   (e.g. Resend domain verification).
 * @param {string} [options.context] - optional label for the console.error
 *   line ("Contacts", "QR flow", …) to speed up debugging.
 * @param {boolean} [options.log=true] - console.error the full technical
 *   detail. Set false when the catch site already logged it.
 * @returns {string} user-facing message
 */
export function friendlyErrorMessage(error, options = {}) {
  const { fallback = FRIENDLY.GENERIC, custom = [], context = '', log = true } = options
  const raw = error instanceof Error ? error.message : String(error ?? '')

  // Full technical detail ALWAYS goes to the console for debugging — only the
  // user-facing return value below is sanitized.
  if (log && error != null) console.error(`[error${context ? ` · ${context}` : ''}]`, error)
  else if (raw) console.error(`[error${context ? ` · ${context}` : ''}]`, raw)

  // 0. Never surface raw network failure text.
  if (raw && matchesNetwork(raw)) return FRIENDLY.NETWORK

  // 1. Errors already translated stay as they are (avoids double-handling).
  if (raw && Object.values(FRIENDLY).includes(raw)) return raw

  // 2. Explicit status codes (Error.status or "(404)"-style text).
  const status = detectStatus(error)
  if (status) {
    const statusMessage = messageForStatus(status)
    if (statusMessage) return statusMessage
    if (isTechnicalError(raw)) return fallback
    return raw
  }

  // 3. Caller-provided, domain-specific rules (actionable provider errors).
  const lowered = raw.toLowerCase()
  for (const rule of custom) {
    if (typeof rule.match === 'string' ? lowered.includes(rule.match.toLowerCase()) : rule.match.test(raw)) {
      return rule.message
    }
  }

  // 4. Keep useful, already-human backend messages (e.g. Resend setup errors
  //    phrased for users) — but only after stripping them of any embedded
  //    technical detail. "Resend rejected the test email: The sending domain
  //    has not been verified" survives; "PGRST123 …" or JSON dumps do not.
  const sanitized = sanitizeProviderMessage(raw)
  if (sanitized) return sanitized

  // 5. Everything else → generic fallback (never the raw string).
  return fallback
}

// Provider messages may embed useful context ("Resend rejected the test
// email: <reason>") or pure technical noise. Returns a cleaned message, or
// null when nothing human-safe remains.
function sanitizeProviderMessage(raw) {
  if (raw == null) return null
  let text
  try {
    if (typeof raw === 'object') {
      const detail =
        raw.message ||
        (raw.error && typeof raw.error === 'object' ? raw.error.message : null) ||
        (raw.error && typeof raw.error === 'string' ? raw.error : null)
      text = detail || JSON.stringify(raw)
    } else {
      text = String(raw)
    }
    if (typeof text !== 'string') return null
  } catch {
    return null
  }
  text = text.trim()
  if (!text) return null
  // Strip trailing JSON payloads and stack-frame noise.
  text = text.split(/\n\s*at\s+/)[0]
  text = text.replace(/[{}[\]"].*$/, '')
  text = text.replace(/:\s*(TypeError|ReferenceError|Error):?.*$/i, '')
  text = text.trim()
  if (!text || isTechnicalError(text)) return null
  return text
}

export const ERROR_MESSAGES = FRIENDLY
export default friendlyErrorMessage
