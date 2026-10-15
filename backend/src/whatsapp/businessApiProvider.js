// NOTE: env vars are loaded once by src/server.js from backend/.env —
// do not add a dotenv.config() here.
const axios = require('axios');
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
        const info = await this.testConnection(userId);
        const current = this._getConfig(userId);
        current.status = 'connected';
        // Kept so quality webhooks (which carry the display number, not the
        // phone number id) can be routed to this user.
        if (info?.displayPhoneNumber) current.displayPhoneNumber = info.displayPhoneNumber;
        current.health = null;
        return { status: current.status };
    }

    /**
     * Messaging-limit tier and quality rating of the connected number.
     * Cached for 10 minutes. Returns null when unavailable (never throws).
     */
    async getPhoneHealth(userId, { maxAgeMs = 10 * 60_000 } = {}) {
        const config = this.userConfigs.get(userId);
        if (!config || config.status !== 'connected') return null;
        if (config.health && Date.now() - config.health.checkedAt < maxAgeMs) return config.health;
        try {
            const response = await axios.get(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}`, {
                params: { fields: 'quality_rating,messaging_limit_tier,status,display_phone_number' },
                headers: { Authorization: `Bearer ${config.accessToken}` },
                timeout: 15000,
            });
            const data = response.data || {};
            if (data.display_phone_number) config.displayPhoneNumber = data.display_phone_number;
            config.health = {
                qualityRating: data.quality_rating ? String(data.quality_rating).toUpperCase() : null,
                messagingLimitTier: data.messaging_limit_tier || null,
                dailyRecipientLimit: tierLimit(data.messaging_limit_tier),
                status: data.status || null,
                checkedAt: Date.now(),
            };
            return config.health;
        } catch (error) {
            console.warn(`[businessApi] health check failed for user=${userId}: ${error?.response?.status || ''} ${error.message}`);
            return config.health || null;
        }
    }

    /** Record a quality event from the webhook so the next check sees it. */
    noteQualityEvent(userId, event, currentLimit) {
        const config = this.userConfigs.get(userId);
        if (!config) return;
        config.health = {
            ...(config.health || {}),
            qualityEvent: event || null,
            messagingLimitTier: currentLimit || config.health?.messagingLimitTier || null,
            dailyRecipientLimit: tierLimit(currentLimit) ?? config.health?.dailyRecipientLimit ?? null,
            checkedAt: Date.now(),
        };
    }

    findUserIdByDisplayPhone(displayPhoneNumber) {
        const digits = String(displayPhoneNumber || '').replace(/\D/g, '');
        if (!digits) return null;
        for (const [userId, config] of this.userConfigs) {
            if (String(config.displayPhoneNumber || '').replace(/\D/g, '') === digits) return userId;
        }
        return null;
    }

    async _uploadMedia(config, media) {
        if (!Buffer.isBuffer(media?.buffer)) {
            throw new Error('Campaign attachment is unavailable. Resume the campaign to reload it.');
        }
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('file', media.buffer, {
            filename: media.filename || 'attachment',
            contentType: media.mimetype || 'application/octet-stream',
        });
        form.append('type', media.type || 'image');
        const uploadResponse = await axios.post(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/media`, form, {
            headers: { Authorization: `Bearer ${config.accessToken}`, ...form.getHeaders() },
            timeout: 30000,
        });
        return uploadResponse.data.id;
    }

    /**
     * Send an approved message template (required for business-initiated
     * messages outside the 24-hour customer service window).
     * template: { name, language, bodyParams: string[] }
     */
    async sendTemplate(userId, phone, template, media = null, options = {}) {
        const config = this._getConfig(userId);
        if (config.status !== 'connected') throw new Error('WhatsApp Business API is not connected');
        if (!template?.name) throw new Error('Template name is required.');
        const components = [];
        if (media) {
            const mediaId = await this._uploadMedia(config, media);
            const type = media.type === 'document' ? 'document' : 'image';
            components.push({
                type: 'header',
                parameters: [{ type, [type]: type === 'document' ? { id: mediaId, filename: media.filename } : { id: mediaId } }],
            });
        }
        const bodyParams = Array.isArray(template.bodyParams) ? template.bodyParams : [];
        if (bodyParams.length) {
            components.push({
                type: 'body',
                // WhatsApp rejects empty parameters; send a dash instead.
                parameters: bodyParams.map(value => ({ type: 'text', text: String(value ?? '').trim().slice(0, 1024) || '-' })),
            });
        }
        const response = await axios.post(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: String(phone).replace(/[^\d]/g, ''),
            type: 'template',
            template: {
                name: String(template.name).trim(),
                language: { code: String(template.language || 'en').trim() },
                ...(components.length ? { components } : {}),
            },
            ...callbackField(options),
        }, { headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        return response.data;
    }

    /**
     * Official typing indicator. WhatsApp only supports it in reply to a
     * received message: it marks that message as read and shows "typing…"
     * until the reply is sent (or 25 seconds pass). It cannot be used for
     * business-initiated campaign messages.
     */
    async sendTypingIndicator(userId, inboundMessageId) {
        const config = this._getConfig(userId);
        if (config.status !== 'connected' || !inboundMessageId) return false;
        await axios.post(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: String(inboundMessageId),
            typing_indicator: { type: 'text' },
        }, { headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 });
        return true;
    }

    async disconnect(userId) {
        const config = this.userConfigs.get(userId);
        if (config) config.status = 'disconnected';
    }

    async sendMessage(userId, phone, body, media = null, buttons = null, options = {}) {
        const config = this._getConfig(userId);
        if (config.status !== 'connected') throw new Error('WhatsApp Business API is not connected');
        const text = String(body).trim().substring(0, 4096);
        let message;
        if (media) {
            const mediaId = await this._uploadMedia(config, media);
            if (media.type === 'document') {
                message = {
                    type: 'document',
                    document: { id: mediaId, filename: media.filename, caption: text },
                };
            } else {
                message = {
                    type: 'image',
                    image: { id: mediaId, caption: text },
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
            ...callbackField(options),
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

    /**
     * Collect every event in a webhook payload (Meta may batch several
     * entries and changes): delivery statuses and quality updates.
     */
    extractWebhookEvents(body) {
        const statuses = [];
        const qualityUpdates = [];
        for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
            for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
                const value = change?.value || {};
                if (change?.field === 'phone_number_quality_update') {
                    qualityUpdates.push({
                        displayPhoneNumber: value.display_phone_number || null,
                        event: value.event || null,
                        currentLimit: value.current_limit || null,
                    });
                    continue;
                }
                const phoneNumberId = value?.metadata?.phone_number_id || null;
                for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
                    statuses.push({
                        phoneNumberId,
                        id: status.id,
                        status: status.status,
                        callbackData: status.biz_opaque_callback_data || null,
                        timestamp: status.timestamp ? Number(status.timestamp) * 1000 : Date.now(),
                        errors: Array.isArray(status.errors) ? status.errors.map(error => ({
                            code: error.code,
                            title: error.title || error.message || '',
                            details: error.error_data?.details || '',
                        })) : [],
                    });
                }
            }
        }
        return { statuses, qualityUpdates };
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

// biz_opaque_callback_data is echoed in delivery webhooks (max 512 chars).
function callbackField(options) {
    const value = options?.callbackData ? String(options.callbackData).slice(0, 512) : '';
    return value ? { biz_opaque_callback_data: value } : {};
}

// Business-initiated conversation limits per rolling 24 hours.
function tierLimit(tier) {
    const match = /TIER_(\d+)(K)?/i.exec(String(tier || ''));
    if (!match) return null;
    return Number(match[1]) * (match[2] ? 1000 : 1);
}

module.exports = new WhatsAppBusinessProvider();
module.exports.tierLimit = tierLimit;
