// =============================================================
// Structured campaign logging.
//
// One JSON line per event, so Render's log search can filter on
// "event":"send_failed" or "campaign":17. Phone numbers are masked to
// the last four digits and message bodies are never logged. Error
// text must already be sanitized (describeSendError redacts tokens
// and URLs) before it is passed here.
// =============================================================

function maskPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return `***${digits.slice(-4)}`;
}

function write(level, event, fields = {}) {
    const entry = { scope: 'campaign', event, at: new Date().toISOString() };
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        entry[key] = key === 'phone' ? maskPhone(value) : value;
    }
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

module.exports = {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    maskPhone,
};
