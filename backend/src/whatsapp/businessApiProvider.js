require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const WhatsAppProvider = require('./WhatsAppProvider');

class WhatsAppBusinessProvider extends WhatsAppProvider {
    constructor() {
        super('WhatsApp Business API');
        this.status = 'disconnected';
        this.io = null;
        this.config = this._readConfig();
    }

    setIO(io) { this.io = io; }

    _readConfig() {
        return {
            phoneNumberId: process.env.WABA_PHONE_NUMBER_ID,
            accessToken: process.env.WABA_ACCESS_TOKEN,
            verifyToken: process.env.WABA_WEBHOOK_VERIFY_TOKEN,
            apiVersion: process.env.WABA_API_VERSION || 'v23.0',
        };
    }

    configure(config = {}) {
        this.config = { ...this.config, ...config };
    }

    getStatus() { return this.status; }
    getQRCode() { return null; }

    async testConnection() {
        if (!this.config.phoneNumberId || !this.config.accessToken) {
            throw new Error('Business API Phone Number ID and access token are required.');
        }
        const response = await axios.get(`https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}`, {
            headers: { Authorization: `Bearer ${this.config.accessToken}` },
            timeout: 15000,
        });
        return { id: response.data.id, displayPhoneNumber: response.data.display_phone_number, verifiedName: response.data.verified_name };
    }

    async connect() {
        await this.testConnection();
        this.status = 'connected';
        this.io?.emit('whatsapp:status', { status: this.status, provider: this.name });
        return { status: this.status };
    }

    async initialize() {
        if (this.config.phoneNumberId && this.config.accessToken) {
            try { await this.connect(); } catch (error) { this.status = 'connection_failed'; throw error; }
        }
    }

    async disconnect() {
        this.status = 'disconnected';
        this.io?.emit('whatsapp:status', { status: this.status, provider: this.name });
    }

    async sendMessage(phone, body, jid, media, buttons) {
        if (this.status !== 'connected') throw new Error('WhatsApp Business API is not connected');
        const text = String(body).trim().substring(0, 4096);
        let message;
        if (media) {
            const form = new FormData();
            form.append('messaging_product', 'whatsapp');
            form.append('file', fs.createReadStream(media.path));
            form.append('type', media.type || 'image');
            const uploadResponse = await axios.post(`https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/media`, form, {
                headers: { Authorization: `Bearer ${this.config.accessToken}`, ...form.getHeaders() },
                timeout: 30000,
            });
            
            // Handle different media types
            if (media.type === 'document') {
                message = {
                    type: 'document',
                    document: { id: uploadResponse.data.id, filename: media.filename, caption: text },
                };
            } else {
                // Default to image
                message = {
                    type: 'image',
                    image: { id: uploadResponse.data.id, caption: text },
                };
            }
        } else if (Array.isArray(buttons) && buttons.length) {
            let buttonText = text;
            const replyButtons = buttons.slice(0, 3).map((button, index) => {
                // Cloud API free-form buttons do not support raw URL buttons.
                if (button.type === 'url' && button.url) buttonText += `\n${button.url}`;
                return { type: 'reply', reply: { id: `campaign_button_${index + 1}`, title: String(button.text || '').substring(0, 20) } };
            });
            message = { type: 'interactive', interactive: { type: 'button', body: { text: buttonText }, action: { buttons: replyButtons } } };
        } else {
            message = { type: 'text', text: { preview_url: false, body: text } };
        }
        const response = await axios.post(`https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: String(phone).replace(/[^\d]/g, ''),
            ...message,
        }, { headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        return response.data;
    }

    verifyWebhook(mode, token, challenge) {
        if (mode === 'subscribe' && token && token === this.config.verifyToken) return challenge;
        throw new Error('Webhook verification failed');
    }

    normalizeWebhook(body) {
        const value = body?.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];
        if (!message || message.type !== 'text') return null;
        return { provider: this.name, from: `${message.from}@c.us`, body: message.text?.body || '', id: { id: message.id }, timestamp: message.timestamp };
    }
}

module.exports = WhatsAppBusinessProvider;