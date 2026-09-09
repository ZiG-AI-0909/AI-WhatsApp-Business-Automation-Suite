require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const WhatsAppProvider = require('./WhatsAppProvider');

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
    findUserIdByPhoneNumberId(phoneNumberId) {
        if (!phoneNumberId) return null;
        for (const [userId, config] of this.userConfigs) {
            if (config.phoneNumberId && config.phoneNumberId === phoneNumberId) return userId;
        }
        return null;
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

    verifyWebhook(userId, mode, token, challenge) {
        const config = this._getConfig(userId);
        if (mode === 'subscribe' && token && token === config.verifyToken) return challenge;
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
