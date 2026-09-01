const webProvider = require('./whatsappService');
const WhatsAppBusinessProvider = require('./businessApiProvider');

class WhatsAppProviderManager {
    constructor() {
        this.businessProvider = new WhatsAppBusinessProvider();
        this.activeName = process.env.WHATSAPP_PROVIDER || 'web';
        this.io = null;
    }

    setIO(io) {
        this.io = io;
        webProvider.setIO(io);
        this.businessProvider.setIO(io);
    }

    get active() { return this.activeName === 'business' ? this.businessProvider : webProvider; }
    get providerName() { return this.activeName === 'business' ? 'WhatsApp Business API' : 'WhatsApp Web'; }
    getStatus() { return this.active.getStatus(); }
    getQRDataUrl() { return this.active.getQRDataUrl ? this.active.getQRDataUrl() : null; }
    getLastError() { return webProvider.getLastError?.() || null; }

    initialize() { return this.active.initialize(); }
    async connect() { return this.active.connect ? this.active.connect() : this.active.initialize(); }
    async disconnect() { return this.active.disconnect(); }
    async reconnect() { return this.active.reconnect ? this.active.reconnect() : this.connect(); }
    async sendMessage(phone, body, jid, media, buttons) { return this.active.sendMessage(phone, body, jid, media, buttons); }
    async getChats() { return this.active.getChats ? this.active.getChats() : []; }
    async getContacts() { return this.active.getContacts ? this.active.getContacts() : []; }

    async switchProvider(provider) {
        if (!['web', 'business'].includes(provider)) throw new Error('Provider must be web or business');
        if (provider === this.activeName) return;
        await this.active.disconnect();
        this.activeName = provider;
        this.io?.emit('whatsapp:provider', { provider: this.providerName });
    }

    configureBusiness(config) { this.businessProvider.configure(config); }
    testBusinessConnection() { return this.businessProvider.testConnection(); }
    verifyBusinessWebhook(...args) { return this.businessProvider.verifyWebhook(...args); }

    async handleBusinessWebhook(body) {
        const message = this.businessProvider.normalizeWebhook(body);
        if (!message) return false;
        await webProvider._handleIncoming(message, this.businessProvider.sendMessage.bind(this.businessProvider));
        return true;
    }
}

module.exports = new WhatsAppProviderManager();