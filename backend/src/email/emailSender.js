// =============================================================
// Email sender — sends through the user's own mailbox over SMTP (free).
//
//   smtp   (FREE) — any mailbox you already own: Gmail / Google Workspace
//                   with an App Password, Outlook, Zoho, Brevo's free SMTP…
//                   Uses nodemailer; nothing to pay for.
//
// Per-user credentials live in app_settings (SMTP_PASS is encrypted at
// rest like every other secret). Env vars are a server-wide fallback.
// =============================================================
const db = require('../database/db');
const { decryptSettingIfSecret } = require('../utils/encryption');

const KEYS = {
    provider: 'EMAIL_PROVIDER',
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    user: 'SMTP_USER',
    pass: 'SMTP_PASS',
    fromName: 'SMTP_FROM_NAME',
};

// Ready-made settings so a non-technical user only types email + app password.
const SMTP_PRESETS = {
    'gmail.com': { host: 'smtp.gmail.com', port: 465 },
    'googlemail.com': { host: 'smtp.gmail.com', port: 465 },
    'outlook.com': { host: 'smtp-mail.outlook.com', port: 587 },
    'hotmail.com': { host: 'smtp-mail.outlook.com', port: 587 },
    'live.com': { host: 'smtp-mail.outlook.com', port: 587 },
    'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465 },
    'zoho.com': { host: 'smtp.zoho.com', port: 465 },
    'zohomail.in': { host: 'smtp.zoho.in', port: 465 },
};

let nodemailer = null;
const transports = new Map(); // userId -> { signature, transport }

function pick(stored, key) {
    return String(stored[key] || process.env[key] || '').trim();
}

async function loadStored(userId) {
    const stored = {};
    if (!db.isAvailable()) return stored;
    try {
        const rows = await db.select('app_settings', '*', 'user_id = ?', [userId], 'key', 100, 0);
        for (const row of rows) stored[row.key] = decryptSettingIfSecret(row.key, row.value);
    } catch (error) {
        console.error('[email] failed to load app_settings:', error.message);
    }
    return stored;
}

/** Resolve THIS user's SMTP config (host/port filled from presets when blank). */
function smtpConfigFrom(stored) {
    const user = pick(stored, KEYS.user);
    const domain = user.includes('@') ? user.split('@').pop().toLowerCase() : '';
    const preset = SMTP_PRESETS[domain] || {};
    const host = pick(stored, KEYS.host) || preset.host || '';
    const port = Number(pick(stored, KEYS.port)) || preset.port || 587;
    let pass = pick(stored, KEYS.pass);
    // Google shows App Passwords as "abcd efgh ijkl mnop"; the spaces are not part of it.
    if (/gmail|google/i.test(host)) pass = pass.replace(/\s+/g, '');
    return { host, port, user, pass, fromName: pick(stored, KEYS.fromName) };
}

class EmailSender {
    async getConfig(userId, stored = null) {
        stored = stored || await loadStored(userId);
        const smtp = smtpConfigFrom(stored);
        const smtpReady = !!(smtp.host && smtp.user && smtp.pass);
        // Bulk email sends through the user's own mailbox (free SMTP).
        const provider = 'smtp';
        const ready = smtpReady;
        return {
            provider,
            ready,
            smtp: { host: smtp.host, port: smtp.port, user: smtp.user, fromName: smtp.fromName, passwordSet: !!smtp.pass, ready: smtpReady },
        };
    }

    /** Seam for tests. */
    _getNodemailer() {
        if (!nodemailer) nodemailer = require('nodemailer');
        return nodemailer;
    }

    _transportFor(userId, smtp) {
        const signature = `${smtp.host}|${smtp.port}|${smtp.user}|${smtp.pass}`;
        const cached = transports.get(userId);
        if (cached && cached.signature === signature) return cached.transport;
        if (cached) { try { cached.transport.close(); } catch { /* ignore */ } }
        const transport = this._getNodemailer().createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.port === 465,
            auth: { user: smtp.user, pass: smtp.pass },
            pool: true,
            maxConnections: 1,
            connectionTimeout: 20000,
            greetingTimeout: 15000,
            socketTimeout: 30000,
        });
        transports.set(userId, { signature, transport });
        return transport;
    }

    /**
     * Send one email. Returns { messageId }. Throws an Error with a plain,
     * user-readable message, plus `error.permanent` (bad address — do not
     * retry) or `error.fatal` (login/limit problem — stop the whole campaign).
     */
    async send(userId, { to, subject, html, text, headers, attachments }) {
        const stored = await loadStored(userId);
        const config = await this.getConfig(userId, stored);
        if (!config.ready) {
            const err = new Error('Email sending is not set up yet. Open Settings → Email and add your sending account.');
            err.fatal = true;
            throw err;
        }

        const smtp = smtpConfigFrom(stored);
        const from = smtp.fromName ? `"${smtp.fromName.replace(/"/g, '')}" <${smtp.user}>` : smtp.user;
        try {
            const info = await this._transportFor(userId, smtp).sendMail({ from, to, subject, html, text, headers, attachments });
            return { messageId: info?.messageId || null };
        } catch (error) {
            throw classifySmtpError(error);
        }
    }

    async verify(userId) {
        const stored = await loadStored(userId);
        const smtp = smtpConfigFrom(stored);
        if (!(smtp.host && smtp.user && smtp.pass)) throw new Error('Add your email address and app password, then save, before testing.');
        try {
            await this._transportFor(userId, smtp).verify();
        } catch (error) {
            throw classifySmtpError(error);
        }
    }
}

/** Turn SMTP failures into plain-language messages (no codes on screen). */
function classifySmtpError(error) {
    const raw = `${error?.response || ''} ${error?.message || ''}`;
    const code = Number(error?.responseCode) || 0;
    let message = 'The email could not be sent. Please try again later.';
    let fatal = false;
    let permanent = false;
    if (error?.code === 'EAUTH' || code === 535 || /auth|credentials|password/i.test(raw)) {
        message = 'Your email login was refused. For Gmail, use an App Password (not your normal password) and check the email address.';
        fatal = true;
    } else if (/daily|limit exceeded|quota|too many/i.test(raw) || code === 421 || code === 454) {
        message = 'Your email account has reached its sending limit for now. The campaign was paused — resume it later (Gmail resets after 24 hours).';
        fatal = true;
    } else if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(error?.code)) {
        message = 'Could not connect to your email server. Check the server name and port, or try again in a minute.';
        fatal = true;
    } else if (code >= 550 && code < 560 || /recipient|mailbox|does not exist|invalid address|no such user/i.test(raw)) {
        message = 'This email address does not exist or refused the email.';
        permanent = true;
    }
    const err = new Error(message);
    err.fatal = fatal;
    err.permanent = permanent;
    return err;
}

module.exports = new EmailSender();
module.exports.SMTP_PRESETS = SMTP_PRESETS;
module.exports.classifySmtpError = classifySmtpError;
module.exports.smtpConfigFrom = smtpConfigFrom;
module.exports._transports = transports;
