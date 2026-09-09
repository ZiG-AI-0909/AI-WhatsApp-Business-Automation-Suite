// =============================================================
// Resend email service — per-user bring-your-own-key.
//
// Each user's Resend credentials (API key, verified from-address,
// from-name) live in the per-user app_settings key-value store that
// multi-tenant Phase 1 introduced (composite PK (user_id, key), keys
// mirror the env-var names so process.env fallback works transparently).
// Stored settings always take precedence over server-level env defaults.
//
// Phase 1 scope: config read/round-trip + single test email. Bulk
// campaign sending arrives in Phase 2 and will reuse loadUserConfig().
// =============================================================
const db = require('../database/db');

// Keys as stored in app_settings. They match the env-var names on purpose:
// mergedSetting()/env fallback only needs the raw key string.
const SETTING_KEYS = {
    apiKey: 'RESEND_API_KEY',
    fromEmail: 'RESEND_FROM_EMAIL',
    fromName: 'RESEND_FROM_NAME',
};

let ResendClass = null;

class ResendService {
    /**
     * Load THIS user's Resend config: per-user app_settings first,
     * server env vars as fallback. Never logs or returns the raw key
     * to the client — only the sender-visible fields.
     */
    async _getUserSettings(userId) {
        const stored = {};
        if (db.isAvailable()) {
            try {
                const rows = await db.select('app_settings', '*', 'user_id = ?', [userId], 'key', 100, 0);
                for (const row of rows) stored[row.key] = row.value;
            } catch (error) {
                console.error('[resend] failed to load app_settings:', error.message);
            }
        }
        return {
            apiKey: (stored[SETTING_KEYS.apiKey] || process.env.RESEND_API_KEY || '').trim(),
            fromEmail: (stored[SETTING_KEYS.fromEmail] || process.env.RESEND_FROM_EMAIL || '').trim(),
            fromName: (stored[SETTING_KEYS.fromName] || process.env.RESEND_FROM_NAME || '').trim(),
        };
    }

    /**
     * Public shape for GET /api/settings — same pattern as the `ai` section.
     * `apiKeySet` is a boolean; the raw key is NEVER echoed back.
     */
    async getConfig(userId) {
        const config = await this._getUserSettings(userId);
        return {
            configured: !!(config.apiKey && config.fromEmail),
            apiKeySet: !!config.apiKey,
            fromEmail: config.fromEmail,
            fromName: config.fromName,
        };
    }

    /**
     * Indirection seam so tests can monkeypatch the client (same pattern
     * as sessionManager._getBaileys). Lazy require keeps startup safe.
     */
    _getResend(apiKey) {
        if (!ResendClass) {
            try {
                ({ Resend: ResendClass } = require('resend'));
            } catch (error) {
                throw new Error('The resend package is not installed. Run `npm install resend` in backend/.');
            }
        }
        return new ResendClass(apiKey);
    }

    _formatFrom(config) {
        return config.fromName
            ? `${config.fromName} <${config.fromEmail}>`
            : config.fromEmail;
    }

    /**
     * Pull the most specific, human-readable error out of a Resend
     * failure. Handles: the SDK's returned error object (validation /
     * "domain not verified" style), thrown network errors, and raw
     * axios-style responses in case the API is ever called directly.
     */
    _extractProviderError(error) {
        if (error?.response?.data) {
            const data = error.response.data;
            if (typeof data === 'string') return data;
            if (Array.isArray(data.errors) && data.errors.length) {
                return data.errors.map(e => e.message || String(e)).join('; ');
            }
            return data.message || data.name || JSON.stringify(data);
        }
        return error?.message || 'Unknown error';
    }

    /**
     * Send a single test email using THIS user's saved credentials.
     * Throws an Error whose message surfaces Resend's actual reason
     * (e.g. "domain not verified") — the route passes it straight to
     * the Settings page notice.
     */
    async sendTestEmail(userId, recipientEmail) {
        const config = await this._getUserSettings(userId);
        if (!config.apiKey) {
            throw new Error('No Resend API key saved yet. Add it in Settings → Email (Resend) and save first.');
        }
        if (!config.fromEmail) {
            throw new Error('No "from" address saved yet. Add your verified sender address in Settings → Email (Resend) and save first.');
        }
        if (!recipientEmail) {
            throw new Error('Your account has no email address, so there is nowhere to send the test email.');
        }

        const resend = this._getResend(config.apiKey);
        const from = this._formatFrom(config);
        const subject = 'Test email — your Resend connection works';
        const html =
            '<p>This is a test email sent from your campaign system.</p>' +
            '<p>If you are reading this in your inbox, your Resend API key and from-address are working — you are ready to send email campaigns.</p>';
        const text =
            'This is a test email sent from your campaign system. ' +
            'If you are reading this, your Resend API key and from-address are working.';

        let result;
        try {
            result = await resend.emails.send({ from, to: recipientEmail, subject, html, text });
        } catch (error) {
            // Network/DNS/auth-transport level failure — Resend never answered.
            throw new Error(`Could not reach Resend: ${this._extractProviderError(error)}`);
        }

        if (result && result.error) {
            // SDK returns API errors as a resolved { error } object.
            const detail = result.error.message || result.error.name || 'Unknown Resend error';
            throw new Error(`Resend rejected the test email: ${detail}`);
        }

        return {
            success: true,
            messageId: result?.data?.id || null,
            from,
            message: `Test email sent to ${recipientEmail}. Check your inbox (and spam folder).`,
        };
    }
}

module.exports = new ResendService();
