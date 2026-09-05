require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const pino = require('pino');
const incomingMessageService = require('../conversations/incomingMessageService');

const AUTH_PATH = path.join(__dirname, '..', '..', '..', '.baileys_auth');

class WhatsAppService {
    constructor() {
        this.client = null;
        this._status = 'disconnected';
        this._qrDataUrl = null;
        this._io = null;
        this._lastError = null;
        this._initialized = false;
        this._reconnectPromise = null;
        this._reconnectTimer = null;
        this._baileys = null;
        this.businessName = process.env.BUSINESS_NAME || 'Bhavesh Pipes';
    }

    setIO(io) { this._io = io; }
    _emit(event, data) { this._io?.emit(event, data); }

    _setStatus(status) {
        this._status = status;
        this._emit('whatsapp:status', { status });
        console.log(`WhatsApp: ${status}`);
    }

    getStatus() { return this._status; }
    getQRDataUrl() { return this._qrDataUrl; }
    getLastError() { return this._lastError; }

    _resetAuth() {
        fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        fs.mkdirSync(AUTH_PATH, { recursive: true });
    }

    async initialize() {
        if (this._initialized) return this.client;
        if (!this._baileys) this._baileys = await import('@whiskeysockets/baileys');

        fs.mkdirSync(AUTH_PATH, { recursive: true });
        const { state, saveCreds } = await this._baileys.useMultiFileAuthState(AUTH_PATH);
        const { version } = await this._baileys.fetchLatestBaileysVersion();
        this._initialized = true;
        this._lastError = null;
        this._qrDataUrl = null;
        this._setStatus('initializing');

        const socket = this._baileys.default({
            auth: state,
            version,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Bhavesh Pipes', 'Chrome', '1.0.0'],
        });
        this.client = socket;

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                this._qrDataUrl = await qrcode.toDataURL(qr);
                this._setStatus('waiting_qr');
                this._emit('whatsapp:qr', { qrDataUrl: this._qrDataUrl });
            }
            if (connection === 'open') {
                this._qrDataUrl = null;
                this._lastError = null;
                this._setStatus('connected');
                console.log(`WhatsApp connected as ${this.businessName}`);
                this._emit('whatsapp:ready', { status: 'connected' });
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                this._lastError = lastDisconnect?.error?.message || 'WhatsApp connection closed';
                this._initialized = false;
                this.client = null;
                if (statusCode === this._baileys.DisconnectReason.loggedOut) {
                    this._setStatus('reconnecting');
                    clearTimeout(this._reconnectTimer);
                    this._reconnectTimer = setTimeout(() => {
                        try { this._resetAuth(); } catch (error) {
                            this._lastError = error.message;
                            this._setStatus('disconnected');
                            return;
                        }
                        this.initialize().catch(error => {
                            this._lastError = error.message;
                            this._setStatus('disconnected');
                        });
                    }, 1500);
                    return;
                }
                this._setStatus('reconnecting');
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = setTimeout(() => {
                    this.initialize().catch(error => {
                        this._lastError = error.message;
                        this._setStatus('disconnected');
                    });
                }, 1000);
            }
        });

        socket.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const message of messages) {
                if (message.key.fromMe || !message.message) continue;
                const content = this._baileys.normalizeMessageContent?.(message.message) || message.message;
                const text = this._messageText(content);
                if (!text) continue;
                const phoneKnown = !!message.key.remoteJidAlt;
                const remoteJid = message.key.remoteJidAlt || message.key.remoteJid || '';
                console.log(`WhatsApp incoming message from ${remoteJid}`);
                this._handleIncoming({
                    provider: 'web',
                    from: remoteJid.endsWith('@g.us') ? remoteJid : remoteJid.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    jid: remoteJid,
                    phoneKnown,
                    body: text,
                    id: message.key.id,
                    contact: { name: message.pushName || '' },
                    timestamp: Number(message.messageTimestamp || Date.now() / 1000) * 1000,
                }).catch(error => console.error('WhatsApp incoming message error:', error.message));
            }
        });

        return socket;
    }

    _messageText(message) {
        return message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption || '';
    }

    async reconnect() {
        if (this._reconnectPromise) return this._reconnectPromise;
        this._reconnectPromise = (async () => {
            if (this._status === 'logged_out') this._resetAuth();
            if (this.client) {
                try { this.client.ws?.close(); } catch {}
            }
            this.client = null;
            this._initialized = false;
            this._qrDataUrl = null;
            clearTimeout(this._reconnectTimer);
            this._setStatus('disconnected');
            return this.initialize();
        })().finally(() => { this._reconnectPromise = null; });
        return this._reconnectPromise;
    }

    async disconnect() {
        if (this.client) {
            try { this.client.ws?.close(); } catch {}
        }
        this.client = null;
        this._initialized = false;
        this._qrDataUrl = null;
        clearTimeout(this._reconnectTimer);
        this._setStatus('disconnected');
    }

    async sendMessage(phone, body, jid, media) {
        if (this._status !== 'connected' || !this.client) throw new Error('WhatsApp is not connected');
        let recipientJid = jid;
        if (!recipientJid) {
            const clean = this._normalizePhone(phone);
            if (!clean) throw new Error('Invalid phone number');
            const [recipient] = await this.client.onWhatsApp(clean);
            if (!recipient?.exists || !recipient.jid) throw new Error(`WhatsApp number is not registered: ${clean}`);
            recipientJid = recipient.jid;
        }
        const text = String(body).trim().substring(0, 4096);
        
        if (!media) {
            return this.client.sendMessage(recipientJid, { text });
        }
        
        // Handle different media types
        if (media.type === 'document') {
            return this.client.sendMessage(recipientJid, {
                document: { url: media.path },
                mimetype: media.mimetype,
                fileName: media.filename,
                caption: text,
            });
        }
        
        // Default to image media type
        return this.client.sendMessage(recipientJid, {
            image: { url: media.path },
            caption: text,
        });
    }

    _normalizePhone(phone) {
        const clean = String(phone).replace(/[^\d]/g, '');
        if (!clean) return '';
        if (clean.length === 10 && process.env.DEFAULT_COUNTRY_CODE) return `${process.env.DEFAULT_COUNTRY_CODE}${clean}`;
        return clean;
    }

    async getChats() { return []; }
    async getContacts() { return []; }

    async _handleIncoming(message, sendMessage = this.sendMessage.bind(this)) {
        return incomingMessageService.process(message, sendMessage, this._io);
    }
}

module.exports = new WhatsAppService();
