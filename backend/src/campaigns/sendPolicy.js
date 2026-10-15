// =============================================================
// Campaign send policy: error classification, retry backoff, and
// failure-rate monitoring.
//
// This module decides what the queue does after a send attempt:
//   - pause the whole campaign (rate limits, policy restrictions,
//     quality warnings, auth problems),
//   - retry this recipient later with exponential backoff
//     (temporary/server errors, honouring Retry-After),
//   - or record a permanent failure that is never retried.
//
// It contains no logic that tries to hide automated traffic from
// WhatsApp. Pausing on restriction signals is the intended behaviour.
// =============================================================

// Human-readable reasons, shown in the dashboard and API responses.
const PAUSE_REASONS = {
    whatsapp_disconnected: 'WhatsApp is disconnected. Reconnect to continue; nothing is lost.',
    provider_restriction: 'WhatsApp reported a sending restriction. Wait before resuming and review recent failures.',
    rate_limited: 'WhatsApp asked us to slow down (rate limit). The campaign can resume after the cooldown.',
    account_restricted: 'WhatsApp restricted this number (spam or policy limit). Do not resume until the restriction is lifted in WhatsApp Manager.',
    quality_low: 'WhatsApp lowered or flagged this number\'s quality rating. Review message content and recipient consent before resuming.',
    provider_auth_failed: 'The WhatsApp Business API rejected the credentials. Update the access token in Settings, then resume.',
    provider_account_issue: 'The WhatsApp Business account needs attention (payment, registration or certificate). Fix it in WhatsApp Manager, then resume.',
    template_required: 'These recipients have not messaged you in the last 24 hours, so WhatsApp only allows an approved message template. Add an approved template to the campaign, then resume.',
    template_error: 'WhatsApp rejected the message template (missing, paused, disabled or wrong variables). Fix the template settings, then resume.',
    high_failure_rate: 'Too many recent messages failed. The campaign was paused to protect your number; review the errors before resuming.',
    many_unregistered_numbers: 'Many recent numbers are not on WhatsApp. Messaging unknown numbers is a spam signal; clean the list before resuming.',
    repeated_send_failures: 'The same error repeated several times in a row. Review it before resuming.',
    media_upload_failed: 'The attachment could not be sent. Check the file, then resume.',
    media_load_failed: 'The campaign attachment could not be loaded. Replace it or resume to retry.',
    campaign_start_failed: 'The queued campaign could not start.',
};

const RATE_LIMIT_CODES = new Set(['4', '80007', '130429']);
const ACCOUNT_RESTRICTION_CODES = new Set(['368', '131031', '131048']);
const AUTH_CODES = new Set(['0', '3', '10', '190']);
const ACCOUNT_ISSUE_CODES = new Set(['131042', '131045', '133010']);
const RECIPIENT_RATE_LIMIT_CODES = new Set(['131056']);
const TEMPLATE_REQUIRED_CODES = new Set(['131047', '470']);
const MARKETING_OPT_OUT_CODES = new Set(['131050']);
const TEMPORARY_CODES = new Set(['1', '2', '131000', '131016', '133004']);
// Everything else from the Cloud API (100, 131008, 131009, 131021, 131026,
// 131049, 131051, 130497, 135000, …) is a permanent per-recipient failure.

function errorCode(error) {
    const responseData = error?.response?.data;
    const providerError = responseData?.error;
    const code = providerError?.code ?? responseData?.error_code ?? error?.output?.payload?.code ?? error?.code;
    return code === undefined || code === null ? null : String(code);
}

function errorStatus(error) {
    const status = error?.response?.status || error?.output?.statusCode;
    return status ? Number(status) : null;
}

function errorText(error) {
    const responseData = error?.response?.data;
    const providerError = responseData?.error;
    return [
        providerError?.message,
        providerError?.error_data?.details,
        typeof providerError === 'string' ? providerError : null,
        responseData?.message,
        error?.output?.payload?.message,
        error?.message,
    ].filter(Boolean).join(' ');
}

/**
 * Parse a Retry-After header (seconds or HTTP date) into milliseconds.
 * Returns null when absent or invalid.
 */
function retryAfterMs(error, now = Date.now()) {
    const headers = error?.response?.headers || {};
    const raw = typeof headers.get === 'function' ? headers.get('retry-after') : (headers['retry-after'] ?? headers['Retry-After']);
    if (raw === undefined || raw === null || raw === '') return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(String(raw));
    if (Number.isFinite(at)) return Math.max(0, at - now);
    return null;
}

const TEMPLATE_ERROR = /^132\d{3}$/;

/**
 * Classify a send error.
 * kind:
 *   'pause'            stop the campaign (pauseReason says why)
 *   'opt_out'          recipient opted out of marketing on WhatsApp
 *   'not_registered'   number is not on WhatsApp (permanent)
 *   'retry'            temporary: retry this recipient later
 *   'permanent'        do not retry this recipient
 * Connection and media errors are detected by the queue's existing
 * helpers and are not handled here.
 */
function classifySendError(error) {
    const code = errorCode(error);
    const status = errorStatus(error);
    const text = errorText(error);
    const retryAfter = retryAfterMs(error);

    if (/WhatsApp number is not registered/i.test(text)) return { kind: 'not_registered', code, status };
    if (code && RATE_LIMIT_CODES.has(code)) return { kind: 'pause', pauseReason: 'rate_limited', code, status, retryAfterMs: retryAfter };
    if (code && ACCOUNT_RESTRICTION_CODES.has(code)) return { kind: 'pause', pauseReason: 'account_restricted', code, status, retryAfterMs: retryAfter };
    if (code && AUTH_CODES.has(code) && (status === 401 || status === 403 || code === '190')) {
        return { kind: 'pause', pauseReason: 'provider_auth_failed', code, status };
    }
    if (status === 401) return { kind: 'pause', pauseReason: 'provider_auth_failed', code, status };
    if (code && ACCOUNT_ISSUE_CODES.has(code)) return { kind: 'pause', pauseReason: 'provider_account_issue', code, status };
    if (code && TEMPLATE_REQUIRED_CODES.has(code)) return { kind: 'pause', pauseReason: 'template_required', code, status };
    if (code && TEMPLATE_ERROR.test(code)) return { kind: 'pause', pauseReason: 'template_error', code, status };
    if (code && MARKETING_OPT_OUT_CODES.has(code)) return { kind: 'opt_out', code, status };
    if (code && RECIPIENT_RATE_LIMIT_CODES.has(code)) return { kind: 'retry', code, status, retryAfterMs: retryAfter, minDelayMs: 60_000 };
    if (status === 429) return { kind: 'pause', pauseReason: 'rate_limited', code, status, retryAfterMs: retryAfter };
    // Text signals from WhatsApp Web (Baileys) and older API messages.
    if (/rate[-\s]?overlimit|(?:spam|rate)\s+limit/i.test(text)) return { kind: 'pause', pauseReason: 'rate_limited', code, status, retryAfterMs: retryAfter };
    if (/temporarily\s+(?:been\s+)?(?:blocked|restricted|banned)|account.{0,40}(?:blocked|restricted|banned)/i.test(text)) {
        return { kind: 'pause', pauseReason: 'account_restricted', code, status };
    }
    if (code && TEMPORARY_CODES.has(code)) return { kind: 'retry', code, status, retryAfterMs: retryAfter };
    if (status && status >= 500) return { kind: 'retry', code, status, retryAfterMs: retryAfter };
    if (status === 408) return { kind: 'retry', code, status, retryAfterMs: retryAfter };
    if (status && status >= 400) return { kind: 'permanent', code, status };
    if (code && /^\d+$/.test(code)) return { kind: 'permanent', code, status };
    return { kind: 'retry', code, status, retryAfterMs: retryAfter };
}

/**
 * Exponential backoff for retry number `attempt` (1 = first retry):
 * base × 2^(attempt-1), capped at maxMs. A server-provided Retry-After
 * always wins when it is longer.
 */
function backoffDelayMs({ baseMs = 30_000, attempt = 1, retryAfterMs: serverDelay = null, minDelayMs = 0, maxMs = 60 * 60_000 } = {}) {
    const base = Math.max(1, Number(baseMs) || 30_000);
    const exponent = Math.max(0, Math.floor(Number(attempt) || 1) - 1);
    const computed = Math.min(base * 2 ** exponent, Math.max(base, Number(maxMs) || 60 * 60_000));
    return Math.max(computed, Number(serverDelay) || 0, Number(minDelayMs) || 0);
}

/**
 * Rolling window of recent send outcomes for one campaign worker.
 * Pauses when the failure share or the share of numbers that are not
 * on WhatsApp gets too high: both are signals that the list or the
 * content is hurting the sender number.
 */
class FailureWindow {
    constructor({ size = 20, minSamples = 10, failureRate = 0.5, unregisteredRate = 0.4 } = {}) {
        this.size = Math.max(1, Math.floor(size));
        this.minSamples = Math.max(1, Math.min(this.size, Math.floor(minSamples)));
        this.failureRate = Number(failureRate);
        this.unregisteredRate = Number(unregisteredRate);
        this.outcomes = [];
    }

    record(outcome) {
        this.outcomes.push(outcome);
        if (this.outcomes.length > this.size) this.outcomes.shift();
    }

    reset() { this.outcomes = []; }

    /** Change the most recent `from` outcome (e.g. a send later reported failed). */
    reclassify(from, to) {
        const index = this.outcomes.lastIndexOf(from);
        if (index >= 0) this.outcomes[index] = to;
        else this.record(to);
    }

    /** @returns {null|{reason: string, message: string}} */
    check() {
        const total = this.outcomes.length;
        if (total < this.minSamples) return null;
        const failed = this.outcomes.filter(outcome => outcome === 'failed').length;
        const unregistered = this.outcomes.filter(outcome => outcome === 'not_registered').length;
        if (this.unregisteredRate > 0 && unregistered / total >= this.unregisteredRate) {
            return {
                reason: 'many_unregistered_numbers',
                message: `${unregistered} of the last ${total} numbers are not on WhatsApp.`,
            };
        }
        if (this.failureRate > 0 && (failed + unregistered) / total >= this.failureRate) {
            return {
                reason: 'high_failure_rate',
                message: `${failed + unregistered} of the last ${total} messages failed.`,
            };
        }
        return null;
    }
}

function describePauseReason(reason) {
    return PAUSE_REASONS[reason] || (reason ? String(reason).replaceAll('_', ' ') : '');
}

module.exports = {
    PAUSE_REASONS,
    classifySendError,
    backoffDelayMs,
    retryAfterMs,
    errorCode,
    errorStatus,
    FailureWindow,
    describePauseReason,
};
