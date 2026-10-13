// NOTE: env vars are loaded once by src/server.js from backend/.env —
// do not add a dotenv.config() here.
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const WhatsAppProvider = require('./WhatsAppProvider');
const { parseJsonField } = require('../utils/jsonField');

/**
 * WhatsApp Business API provider — per-user edition.
 *
 * Each user's Cloud API credentials (phone number id, access token)
 * live in a per-user map; nothing is shared globally. Every method
 * takes an explicit userId and only touches that user's config and
 * status. Incoming webhook messages are routed by matching the
 * phone_number_id in the payload to the user who configured it.
 */
class WhatsAppBusinessProvider extends WhatsAppProvider {
    constructor() {
        super('WhatsApp Business API');
        // userId -> { phoneNumberId, accessToken, verifyToken, apiVersion, status }
        this.userConfigs = new Map();
    }

    _readEnvConfig() {
        return {
            phoneNumberId: process.env.WABA_PHONE_NUMBER_ID || '',
            accessToken: process.env.WABA_ACCESS_TOKEN || '',
            verifyToken: process.env.WABA_WEBHOOK_VERIFY_TOKEN || '',
            apiVersion: process.env.WABA_API_VERSION || 'v23.0',
        };
    }

    _getConfig(userId) {
        if (!userId) throw new Error('[businessApi] userId is required');
        if (!this.userConfigs.has(userId)) {
            // Seed from env so single-tenant-style env setup still works,
            // but stored per-user config always takes precedence.
            this.userConfigs.set(userId, { ...this._readEnvConfig(), status: 'disconnected' });
        }
        return this.userConfigs.get(userId);
    }

    configure(userId, config = {}) {
        const current = this._getConfig(userId);
        this.userConfigs.set(userId, { ...current, ...config });
    }

    getStatus(userId) {
        return this.userConfigs.get(userId)?.status || 'disconnected';
    }

    getQRCode() { return null; }

    /**
     * Find which user configured the phone_number_id a webhook
     * message came in for. Returns null if nobody claimed it.
     */
    async findUserIdByPhoneNumberId(phoneNumberId) {
        if (!phoneNumberId) return null;
        for (const [userId, config] of this.userConfigs) {
            if (config.phoneNumberId && config.phoneNumberId === phoneNumberId) return userId;
        }
        const db = require('../database/db');
        if (!db.isAvailable()) return null;
        const rows = await db.select('app_settings', 'user_id, key, value', "key IN ('WABA_CONFIG','WHATSAPP_BUSINESS_API','BUSINESS_API_CONFIG','WABA_PHONE_NUMBER_ID','PHONE_NUMBER_ID','WABA_ACCESS_TOKEN','WABA_WEBHOOK_VERIFY_TOKEN')", [], 'user_id', 1000, 0);
        const { decryptSettingIfSecret } = require('../utils/encryption');
        const configs = new Map();
        for (const row of rows || []) {
            if (!row.user_id) continue;
            const raw = decryptSettingIfSecret(row.key, row.value || '');
            let config = configs.get(row.user_id) || {};
            const parsed = parseJsonField(raw, null);
            if (parsed) config = { ...config, ...parsed };
            if (row.key === 'WABA_PHONE_NUMBER_ID' || row.key === 'PHONE_NUMBER_ID') config.phoneNumberId = raw;
            if (row.key === 'WABA_ACCESS_TOKEN') config.accessToken = raw;
            if (row.key === 'WABA_WEBHOOK_VERIFY_TOKEN') config.verifyToken = raw;
            configs.set(row.user_id, config);
        }
        for (const [userId, config] of configs) {
            const id = config.phoneNumberId || config.phone_number_id;
            if (id && String(id) === String(phoneNumberId)) {
                this.configure(userId, { ...config, phoneNumberId: id });
                return userId;
            }
        }
        return null;
    }

    async getAppSecret(userId) {
        if (userId) {
            try {
                const db = require('../database/db');
                const { decryptSettingIfSecret } = require('../utils/encryption');
                const rows = await db.select('app_settings', 'key, value', "user_id = ? AND key IN ('APP_SECRET','WABA_CONFIG','WHATSAPP_BUSINESS_API','BUSINESS_API_CONFIG')", [userId], '', 20, 0);
                for (const row of rows || []) {
                    const value = decryptSettingIfSecret(row.key, row.value || '');
                    const parsed = parseJsonField(value, null);
                    const secret = parsed?.appSecret || parsed?.app_secret || parsed?.APP_SECRET;
                    if (secret) return secret;
                    if (parsed === null && row.key === 'APP_SECRET' && value) return value;
                }
            } catch (error) {
                console.error('[businessApi] failed to load app secret:', error.message);
            }
        }
        return process.env.WABA_APP_SECRET || process.env.META_APP_SECRET || '';
    }

    async testConnection(userId, config = {}) {
        const effective = { ...this._getConfig(userId), ...config };
        if (!effective.phoneNumberId || !effective.accessToken) {
            throw new Error('Business API Phone Number ID and access token are required.');
        }
        const response = await axios.get(`https://graph.facebook.com/${effective.apiVersion}/${effective.phoneNumberId}`, {
            headers: { Authorization: `Bearer ${effective.accessToken}` },
            timeout: 15000,
        });
        return { id: response.data.id, displayPhoneNumber: response.data.display_phone_number, verifiedName: response.data.verified_name };
    }

    async connect(userId, config = {}) {
        if (config && Object.keys(config).length) this.configure(userId, config);
        await this.testConnection(userId);
        const current = this._getConfig(userId);
        current.status = 'connected';
        return { status: current.status };
    }

    async disconnect(userId) {
        const config = this.userConfigs.get(userId);
        if (config) config.status = 'disconnected';
    }

    async sendMessage(userId, phone, body, media = null, buttons = null) {
        const config = this._getConfig(userId);
        if (config.status !== 'connected') throw new Error('WhatsApp Business API is not connected');
        const text = String(body).trim().substring(0, 4096);
        let message;
        if (media) {
            const form = new FormData();
            form.append('messaging_product', 'whatsapp');
            form.append('file', fs.createReadStream(media.path));
            form.append('type', media.type || 'image');
            const uploadResponse = await axios.post(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/media`, form, {
                headers: { Authorization: `Bearer ${config.accessToken}`, ...form.getHeaders() },
                timeout: 30000,
            });

            if (media.type === 'document') {
                message = {
                    type: 'document',
                    document: { id: uploadResponse.data.id, filename: media.filename, caption: text },
                };
            } else {
                message = {
                    type: 'image',
                    image: { id: uploadResponse.data.id, caption: text },
                };
            }
        } else if (Array.isArray(buttons) && buttons.length) {
            let buttonText = text;
            const replyButtons = buttons.slice(0, 3).map((button, index) => {
                if (button.type === 'url' && button.url) buttonText += `\n${button.url}`;
                return { type: 'reply', reply: { id: `campaign_button_${index + 1}`, title: String(button.text || '').substring(0, 20) } };
            });
            message = { type: 'interactive', interactive: { type: 'button', body: { text: buttonText }, action: { buttons: replyButtons } } };
        } else {
            message = { type: 'text', text: { preview_url: false, body: text } };
        }
        const response = await axios.post(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: String(phone).replace(/[^\d]/g, ''),
            ...message,
        }, { headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        return response.data;
    }

    /**
     * Validate the Meta subscription handshake. `expectedToken` lets the
     * webhook route check per-user tokens from app_settings without a userId;
     * when omitted, the env-level verify token for this user is used.
     */
    verifyWebhook(userId, mode, token, challenge, expectedToken = null) {
        const expected = expectedToken
            ?? (userId ? this._getConfig(userId).verifyToken : process.env.WABA_WEBHOOK_VERIFY_TOKEN);
        if (mode === 'subscribe' && token && expected && token === expected) return challenge;
        throw new Error('Webhook verification failed');
    }

    normalizeWebhook(body) {
        const value = body?.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!message) return { message: null, phoneNumberId };
        if (message.type !== 'text') return { message: null, phoneNumberId };
        return {
            message: {
                provider: this.name,
                from: message.from,
                body: message.text?.body || '',
                id: { id: message.id },
                timestamp: message.timestamp,
            },
            phoneNumberId,
        };
    }
}

module.exports = new WhatsAppBusinessProvider();
