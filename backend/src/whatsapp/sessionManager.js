// =============================================================
// Per-user WhatsApp session manager.
//
// Replaces the old single global Baileys instance. Holds a Map of
// userId -> session. Sessions are created LAZILY — only when the
// owning user requests a connection/QR — never at startup.
//
// SECURITY INVARIANTS:
//  - Every method takes an explicit userId and only ever touches
//    that user's own session. There is no "current" or default
//    session anywhere.
//  - QR codes, statuses, and sockets are never shared across
//    users; all events go to that user's Socket.IO room only.
//  - logout() fully invalidates the WhatsApp link (Baileys
//    logout + deletes the stored auth state), so a fresh QR scan
//    is required next time. disconnect() only drops the socket
//    and KEEPS auth state (used by the idle timeout).
//
// Per-user background automation keeps running: the session lives
// server-side whether or not the user's browser is open. Browser
// disconnect never touches the session.
// =============================================================
const qrcode = require('qrcode');
const pino = require('pino');
const authStateStore = require('./authStateStore');
const businessApiProvider = require('./businessApiProvider');
const incomingMessageService = require('../conversations/incomingMessageService');

// Idle timeout: disconnect (keep auth) sessions with no activity.
// 2 hours — see README-phase2 or commit notes for reasoning.
const IDLE_TIMEOUT_MS = Number(process.env.WHATSAPP_SESSION_IDLE_TIMEOUT_MS || 2 * 60 * 60 * 1000);

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

class SessionManager {
    constructor() {
        this.sessions = new Map(); // userId -> session record
        this._io = null;
        this._baileys = null;
        this._baileysPromise = null;
    }

    setIO(io) { this._io = io; }

    async _getBaileys() {
        if (this._baileys) return this._baileys;
        if (!this._baileysPromise) {
            this._baileysPromise = import('@whiskeysockets/baileys').then((mod) => {
                this._baileys = mod;
                return mod;
            });
        }
        return this._baileysPromise;
    }

    // ---- Room-scoped emit ------------------------------------
    _emitToUser(userId, event, data) {
        if (!this._io || !userId) return;
        this._io.to(`user:${userId}`).emit(event, data);
    }

    _pushStatus(userId, status, extra = {}) {
        const session = this.sessions.get(userId);
        if (!session) return;
        session.status = status;
        if (extra.lastError !== undefined) session.lastError = extra.lastError;
        this._emitToUser(userId, 'whatsapp:status', { status, ...extra });
        console.log(`[wa:${userId}] status: ${status}${extra.lastError ? ` (${extra.lastError})` : ''}`);
    }

    // ---- Read-only accessors (own session only) --------------

    getStatus(userId) {
        const session = this.sessions.get(userId);
        if (!session) return 'disconnected';
        return session.status;
    }

    getQRDataUrl(userId) {
        const session = this.sessions.get(userId);
        if (!session) return null;
        return session.qrDataUrl;
    }

    getLastError(userId) {
        const session = this.sessions.get(userId);
        return session?.lastError || null;
    }

    // ---- Session lifecycle -----------------------------------

    /**
     * Create (or return) the user's session, then start the Baileys
     * socket with Supabase-backed auth state. Lazy: called only when
     * the user asks for a connection/QR.
     */
    async initialize(userId) {
        if (!userId) throw new Error('[sessionManager] userId is required');
        const existing = this.sessions.get(userId);
        if (existing && existing.socket) return existing.socket;

        const baileys = await this._getBaileys();

        const session = existing || {
            userId,
            socket: null,
            status: 'disconnected',
            qrDataUrl: null,
            lastError: null,
            authState: null,       // { state, saveCreds, flush, destroy }
            intentionalClose: false,
            reconnectAttempts: 0,
            reconnectTimer: null,
            idleTimer: null,
            lastActivityAt: Date.now(),
        };
        this.sessions.set(userId, session);

        session.intentionalClose = false;
        clearTimeout(session.reconnectTimer);

        // Load this user's auth state from Supabase.
        const auth = await authStateStore.useSupabaseAuthState(userId);
        session.authState = auth;

        const { version } = await baileys.fetchLatestBaileysVersion();

        this._pushStatus(userId, 'initializing', { lastError: null });

        const socket = baileys.default({
            auth: auth.state,
            version,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Bhavesh's Project", 'Chrome', '1.0.0'],
        });
        session.socket = socket;
        session.lastActivityAt = Date.now();

        socket.ev.on('creds.update', () => auth.saveCreds());

        socket.ev.on('connection.update', async (update) => {
            try { await this._onConnectionUpdate(userId, update); }
            catch (error) { console.error(`[wa:${userId}] connection.update handler error:`, error.message); }
        });

        socket.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;
            this._touchActivity(userId);
            for (const message of messages) {
                if (message.key.fromMe || !message.message) continue;
                const content = baileys.normalizeMessageContent?.(message.message) || message.message;
                const text = this._messageText(content);
                if (!text) continue;
                const phoneKnown = !!message.key.remoteJidAlt;
                const remoteJid = message.key.remoteJidAlt || message.key.remoteJid || '';
                this._handleIncoming(userId, {
                    provider: 'web',
                    from: remoteJid.endsWith('@g.us') ? remoteJid : remoteJid.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    jid: remoteJid,
                    phoneKnown,
                    body: text,
                    id: message.key.id,
                    contact: { name: message.pushName || '' },
                    timestamp: Number(message.messageTimestamp || Date.now() / 1000) * 1000,
                }).catch((error) => console.error(`[wa:${userId}] incoming message error:`, error.message));
            }
        });

        this._armIdleTimer(userId);
        return socket;
    }

    async _onConnectionUpdate(userId, { connection, lastDisconnect, qr }) {
        const session = this.sessions.get(userId);
        if (!session) return;

        if (qr) {
            session.qrDataUrl = await qrcode.toDataURL(qr);
            this._pushStatus(userId, 'waiting_qr');
            // QR goes ONLY to this user's room.
            this._emitToUser(userId, 'whatsapp:qr', { qrDataUrl: session.qrDataUrl });
            return;
        }

        if (connection === 'open') {
            session.qrDataUrl = null;
            session.lastError = null;
            session.reconnectAttempts = 0;
            session.lastActivityAt = Date.now();
            this._pushStatus(userId, 'connected');
            this._armIdleTimer(userId);
            return;
        }

        if (connection === 'close') {
            const baileys = this._baileys;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            session.lastError = lastDisconnect?.error?.message || 'WhatsApp connection closed';
            session.socket = null;

            const loggedOut = baileys && statusCode === baileys.DisconnectReason.loggedOut;
            if (session.intentionalClose) {
                // Idle disconnect or explicit disconnect(): stop here quietly.
                // Auth state stays in Supabase so the next initialize() re-links
                // without a QR scan.
                this._pushStatus(userId, 'disconnected');
                return;
            }

            if (loggedOut) {
                // WhatsApp invalidated the link remotely. Wipe stored creds so
                // the user gets a fresh QR next time, then retry cleanly.
                try { await session.authState?.destroy(); } catch {}
                try { await authStateStore.deleteAuthState(userId); } catch (error) {
                    console.error(`[wa:${userId}] failed to delete logged-out auth state:`, error.message);
                }
                session.authState = null;
                this._pushStatus(userId, 'logged_out');
                return;
            }

            // Unexpected drop → auto-reconnect with stored auth state,
            // capped exponential backoff. Does not require the browser.
            this._pushStatus(userId, 'reconnecting');
            session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
            const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(session.reconnectAttempts, 7), RECONNECT_MAX_MS);
            clearTimeout(session.reconnectTimer);
            session.reconnectTimer = setTimeout(() => {
                this.initialize(userId).catch((error) => {
                    console.error(`[wa:${userId}] auto-reconnect failed:`, error.message);
                    this._pushStatus(userId, 'disconnected', { lastError: error.message });
                });
            }, delay);
        }
    }

    _messageText(message) {
        return message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption || '';
    }

    async _handleIncoming(userId, message) {
        await incomingMessageService.process(message, userId, this._io);
    }

    /**
     * Drop the socket only — auth state stays in Supabase so the
     * next initialize() reconnects without a QR scan.
     */
    async disconnect(userId) {
        const session = this.sessions.get(userId);
        if (!session) return;
        session.intentionalClose = true;
        clearTimeout(session.reconnectTimer);
        clearTimeout(session.idleTimer);
        try { session.socket?.ws?.close(); } catch {}
        session.socket = null;
        session.qrDataUrl = null;
        this._pushStatus(userId, 'disconnected');
    }

    /**
     * REAL logout (explicit Sign Out only):
     *  1. Call Baileys' logout() so WhatsApp invalidates the link
     *     server-side (a fresh QR scan is required next time).
     *  2. Drop the socket.
     *  3. Delete this user's whatsapp_sessions row so no stale
     *     credentials linger.
     * Only ever affects this userId.
     */
    async logout(userId) {
        const session = this.sessions.get(userId);
        clearTimeout(session?.reconnectTimer);
        clearTimeout(session?.idleTimer);

        if (session?.socket) {
            session.intentionalClose = true;
            try { await session.socket.logout(); }
            catch (error) { console.error(`[wa:${userId}] Baileys logout error:`, error.message); }
            try { session.socket?.ws?.close(); } catch {}
        }

        // Remove local session record entirely.
        try { session?.authState?.destroy(); } catch {}
        if (userId) this.sessions.delete(userId);

        // Delete stored auth state — this is what makes the logout real.
        await authStateStore.deleteAuthState(userId);

        console.log(`[wa:${userId}] logged out (auth state deleted)`);
    }

    // ---- Sending (own session only) ---------------------------

    async sendMessage(userId, phone, body, jid = null, media = null) {
        const session = this.sessions.get(userId);
        if (!session || session.status !== 'connected' || !session.socket) {
            throw new Error('WhatsApp is not connected');
        }
        this._touchActivity(userId);

        let recipientJid = jid;
        if (!recipientJid) {
            const clean = this._normalizePhone(phone);
            if (!clean) throw new Error('Invalid phone number');
            const [recipient] = await session.socket.onWhatsApp(clean);
            if (!recipient?.exists || !recipient.jid) throw new Error(`WhatsApp number is not registered: ${clean}`);
            recipientJid = recipient.jid;
        }

        const text = String(body).trim().substring(0, 4096);
        if (!media) return session.socket.sendMessage(recipientJid, { text });
        if (media.type === 'document') {
            return session.socket.sendMessage(recipientJid, {
                document: { url: media.path },
                mimetype: media.mimetype,
                fileName: media.filename,
                caption: text,
            });
        }
        return session.socket.sendMessage(recipientJid, {
            image: { url: media.path },
            caption: text,
        });
    }

    // ---- Business API (per-user config, no shared state) -------

    async connectBusiness(userId, config = {}) {
        businessApiProvider.configure(userId, config);
        return businessApiProvider.connect(userId);
    }

    async testBusinessConnection(userId, config = {}) {
        return businessApiProvider.testConnection(userId, config);
    }

    getBusinessStatus(userId) {
        return businessApiProvider.getStatus(userId);
    }

    // ---- Idle timeout (resource safety) ------------------------
    //
    // Disconnects (never logs out) a session after inactivity to
    // free memory on Render's free tier (~512MB). Auth state stays
    // in Supabase; the next activity reconnects automatically.

    _touchActivity(userId) {
        const session = this.sessions.get(userId);
        if (!session) return;
        session.lastActivityAt = Date.now();
        this._armIdleTimer(userId);
    }

    _armIdleTimer(userId) {
        const session = this.sessions.get(userId);
        if (!session) return;
        clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(async () => {
            const current = this.sessions.get(userId);
            if (!current || !current.socket) return;
            const idleMs = Date.now() - (current.lastActivityAt || 0);
            if (idleMs < IDLE_TIMEOUT_MS) { this._armIdleTimer(userId); return; }
            console.log(`[wa:${userId}] idle for ${Math.round(idleMs / 60000)}min — disconnecting socket (auth state kept)`);
            await this.disconnect(userId);
        }, IDLE_TIMEOUT_MS + 1000);
    }

    // ---- Misc ---------------------------------------------------

    _normalizePhone(phone) {
        const clean = String(phone).replace(/[^\d]/g, '');
        if (!clean) return '';
        if (clean.length === 10 && process.env.DEFAULT_COUNTRY_CODE) return `${process.env.DEFAULT_COUNTRY_CODE}${clean}`;
        return clean;
    }

    async shutdown() {
        // Graceful shutdown: flush all pending auth-state writes and
        // close sockets. Not a logout — auth state stays.
        for (const [userId, session] of this.sessions) {
            clearTimeout(session.reconnectTimer);
            clearTimeout(session.idleTimer);
            try { await session.authState?.flush(); } catch {}
            try { session.socket?.ws?.close(); } catch {}
        }
    }
}

module.exports = new SessionManager();
module.exports.SessionManager = SessionManager;
module.exports.IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS;
