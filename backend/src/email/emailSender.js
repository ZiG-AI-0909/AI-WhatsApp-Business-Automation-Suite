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
const axios = require('axios');
const db = require('../database/db');
const { decryptSettingIfSecret } = require('../utils/encryption');

const KEYS = {
    provider: 'EMAIL_PROVIDER',
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    user: 'SMTP_USER',
    pass: 'SMTP_PASS',
    fromName: 'SMTP_FROM_NAME',
    brevoKey: 'BREVO_API_KEY',
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
        // Brevo (free, HTTPS) is used whenever its key is saved: hosts such as
        // Render's free plan block SMTP ports, but never HTTPS.
        const brevoKey = pick(stored, KEYS.brevoKey);
        const brevoReady = !!(brevoKey && smtp.user);
        const provider = brevoKey ? 'brevo' : 'smtp';
        const ready = provider === 'brevo' ? brevoReady : smtpReady;
        return {
            provider,
            ready,
            smtp: { host: smtp.host, port: smtp.port, user: smtp.user, fromName: smtp.fromName, passwordSet: !!smtp.pass, ready: smtpReady },
            brevo: { keySet: !!brevoKey, ready: brevoReady },
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
        if (config.provider === 'brevo') {
            return this._sendBrevo(pick(stored, KEYS.brevoKey), smtp, { to, subject, html, text, headers, attachments });
        }
        const from = smtp.fromName ? `"${smtp.fromName.replace(/"/g, '')}" <${smtp.user}>` : smtp.user;
        try {
            const info = await this._transportFor(userId, smtp).sendMail({ from, to, subject, html, text, headers, attachments });
            return { messageId: info?.messageId || null };
        } catch (error) {
            throw classifySmtpError(error);
        }
    }

    /** Seam for tests. */
    async _brevoRequest(method, path, apiKey, data) {
        const response = await axios({ method, url: `https://api.brevo.com/v3${path}`, data, headers: { 'api-key': apiKey, accept: 'application/json' }, timeout: 30000 });
        return response.data;
    }

    async _sendBrevo(apiKey, smtp, { to, subject, html, text, headers, attachments = [] }) {
        // Brevo has no inline (cid) pictures: send any cid pictures as normal
        // attachments and drop their <img> tags. Campaign emails use public
        // picture links instead, so this only affects test emails.
        const cleanHtml = String(html).replace(/<p><img src="cid:[^"]*"[^>]*><\/p>\n?/g, '');
        const payload = {
            sender: { email: smtp.user, ...(smtp.fromName ? { name: smtp.fromName } : {}) },
            to: [{ email: to }],
            subject,
            htmlContent: cleanHtml,
            textContent: text,
            ...(headers ? { headers } : {}),
            ...(attachments.length ? { attachment: attachments.map(a => ({ name: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}),
        };
        try {
            const data = await this._brevoRequest('post', '/smtp/email', apiKey, payload);
            return { messageId: data?.messageId || null };
        } catch (error) {
            throw classifyBrevoError(error);
        }
    }

    async verify(userId) {
        const stored = await loadStored(userId);
        const brevoKey = pick(stored, KEYS.brevoKey);
        if (brevoKey) {
            try { await this._brevoRequest('get', '/account', brevoKey); } catch (error) { throw classifyBrevoError(error); }
            if (!pick(stored, KEYS.user)) throw new Error('Add the email address you send from, then save.');
            return;
        }
        const smtp = smtpConfigFrom(stored);
        if (!(smtp.host && smtp.user && smtp.pass)) throw new Error('Add your email address and app password, then save, before testing.');
        try {
            await this._transportFor(userId, smtp).verify();
        } catch (error) {
            throw classifySmtpError(error);
        }
    }
}

/** Turn Brevo API failures into plain-language messages. */
function classifyBrevoError(error) {
    const status = error?.response?.status || 0;
    const raw = `${error?.response?.data?.message || ''} ${error?.response?.data?.code || ''} ${error?.message || ''}`;
    let message = 'The email could not be sent. Please try again later.';
    let fatal = false;
    let permanent = false;
    if (status === 401 || /key not found|unauthori[sz]ed|invalid api/i.test(raw)) {
        message = 'Brevo did not accept your API key. Copy it again from Brevo → SMTP & API → API Keys.';
        fatal = true;
    } else if (/sender/i.test(raw) && /valid|verif|not.*(allowed|authori)/i.test(raw)) {
        message = 'Your sender address is not verified in Brevo yet. In Brevo open Senders, add this email address and click the link Brevo emails you.';
        fatal = true;
    } else if (status === 402 || status === 429 || /credit|quota|limit|not enough/i.test(raw)) {
        message = 'Your Brevo account has reached its sending limit for now (free plan: 300 emails a day). The campaign was paused — resume it later.';
        fatal = true;
    } else if (status === 403 || /not activated|suspend|blocked/i.test(raw)) {
        message = 'Brevo has not activated sending on your account yet. Check your Brevo email or dashboard for what they need.';
        fatal = true;
    } else if (status === 400 && /email|recipient|to/i.test(raw)) {
        message = 'This email address is not valid.';
        permanent = true;
    } else if (!status) {
        message = 'Could not reach Brevo. Please try again in a minute.';
        fatal = true;
    }
    const err = new Error(message);
    err.fatal = fatal;
    err.permanent = permanent;
    return err;
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
module.exports.classifyBrevoError = classifyBrevoError;
module.exports.smtpConfigFrom = smtpConfigFrom;
module.exports._transports = transports;
