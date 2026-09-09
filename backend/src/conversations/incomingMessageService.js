const db = require('../database/db');
const contactService = require('../contacts/contactService');
const conversationService = require('./conversationService');
const aiService = require('../ai/aiService');
const knowledgeBase = require('../ai/knowledgeBase');
const { emitToUser } = require('../realtime');

const HUMAN_HANDOFF_TRIGGERS = [
    /\btalk\s*to\s*(a\s*)?(human|person|agent|someone|sales|manager|representative)\b/i,
    /\bcall\s*me\b/i, /\bsales(person|man|rep(resentative)?)?\b/i,
    /\bmanager\b/i, /\bhuman\b/i, /\bphone\s*(call|number)\b/i,
    /\bmujhe\s*(call|baat)\b/i,
];

const OPT_OUT_PATTERNS = [
    /\bstop\b/i, /\bunsubscribe\b/i, /\bremove\s*me\b/i,
    /\bdon['\u2019]?t\s*(message|contact|text|whatsapp)\s*me\b/i,
    /\bno\s*more\s*(messages?|texts?)\b/i, /\bbandh\s*karo\b/i,
    /\bmat\s*bhejo\b/i, /\bnahi\s*chahiye\b/i,
];

/**
 * Load per-user runtime settings (AI key/model, business name) from
 * the per-user app_settings table, falling back to env defaults.
 * Cached briefly to avoid hammering Supabase on every message.
 */
const settingsCache = new Map(); // userId -> { settings, loadedAt }
const SETTINGS_CACHE_MS = 60 * 1000;

async function getUserSettings(userId) {
    if (!userId) return {};
    const cached = settingsCache.get(userId);
    if (cached && Date.now() - cached.loadedAt < SETTINGS_CACHE_MS) return cached.settings;

    let settings = {};
    try {
        if (db.isAvailable()) {
            const rows = await db.select('app_settings', 'key, value', 'user_id = ?', [userId], '', 100, 0);
            for (const row of rows) settings[row.key] = row.value;
        }
    } catch (error) {
        console.error(`[incoming] failed to load settings for user ${userId}:`, error.message);
    }
    settingsCache.set(userId, { settings, loadedAt: Date.now() });
    return settings;
}

class IncomingMessageService {
    normalize(input, provider = 'web') {
        const from = String(input.from || '').replace('@c.us', '');
        return {
            provider: input.provider || provider,
            messageId: input.messageId || input.id?.id || input.id || null,
            from,
            jid: input.jid,
            phoneKnown: input.phoneKnown !== false,
            contact: { phone: from, name: input.contact?.name || input._data?.notifyName || input._data?.pushname || '' },
            text: String(input.text ?? input.body ?? '').trim(),
            timestamp: input.timestamp || Date.now(),
            type: input.type || 'text',
        };
    }

    /**
     * Process an incoming message for a SPECIFIC user.
     * @param {object} input - raw provider message
     * @param {string} userId - owner of the WhatsApp session that received it (required)
     * @param {object} io - Socket.IO server (events go to this user's room only)
     * @param {function} [sendMessage] - send fn bound to the SAME user's session;
     *        defaults to that user's own Baileys session.
     */
    async process(input, userId, io, sendMessage = null) {
        if (!userId) {
            // Security invariant: a message without a user is dropped, never
            // saved — orphan (NULL user_id) rows must not come back.
            console.error('[incoming] REJECTED message without userId — would create orphan rows');
            return false;
        }
        if (!sendMessage) {
            // Default: reply through the SAME user's own Baileys session.
            const sessionManager = require('../whatsapp/sessionManager');
            sendMessage = (phone, body, jid) => sessionManager.sendMessage(userId, phone, body, jid);
        }

        const incoming = this.normalize(input, input.provider || 'web');
        if (!incoming.from || !incoming.text || incoming.type !== 'text') return false;
        if (incoming.from.includes('@g.us') || incoming.from === 'status@broadcast') return false;

        // Phase 1 gap closed: every row created here is owned by userId.
        const { conversation, contact } = await conversationService.getOrCreate(incoming.from, incoming.jid, incoming.phoneKnown, incoming.contact.name, userId);
        const saved = await conversationService.saveMessage(conversation.id, 'inbound', incoming.text, incoming.messageId, 'received', {
            provider: incoming.provider, sender: incoming.from, timestamp: incoming.timestamp,
        }, userId);
        if (!saved) return false;

        emitToUser(io, userId, 'message:new', { conversationId: conversation.id, ...incoming, name: contact.name || incoming.contact.name || incoming.from, direction: 'inbound', body: incoming.text });

        const userSettings = await getUserSettings(userId);
        const businessName = (userSettings.BUSINESS_NAME || process.env.BUSINESS_NAME || 'our business').trim();

        if (OPT_OUT_PATTERNS.some((pattern) => pattern.test(incoming.text))) {
            await contactService.setOptOut(incoming.from, userId);
            await conversationService.setStatus(conversation.id, 'resolved', userId);
            const ack = 'You have been unsubscribed from our marketing messages. You will no longer receive promotional messages from us.';
            await this._reply(conversation.id, incoming, ack, sendMessage, io, userId);
            return true;
        }

        if (HUMAN_HANDOFF_TRIGGERS.some((pattern) => pattern.test(incoming.text)) && conversation.ai_enabled) {
            await conversationService.setAIEnabled(conversation.id, false, userId);
            await conversationService.setStatus(conversation.id, 'human_takeover', userId);
            emitToUser(io, userId, 'conversation:human_takeover', { conversationId: conversation.id, phone: incoming.from });
            const handoff = "I understand you'd like to speak with our sales team. We've flagged your conversation and a representative will get in touch with you shortly.";
            await this._reply(conversation.id, incoming, handoff, sendMessage, io, userId);
            return true;
        }

        if (!conversation.ai_enabled) return true;

        // Per-user AI configuration: the user's own stored key, env fallback.
        const userApiKey = userSettings.AI_API_KEY || process.env.AI_API_KEY || '';
        const userBaseURL = userSettings.AI_BASE_URL || process.env.AI_BASE_URL;
        const userModel = userSettings.AI_MODEL || process.env.AI_MODEL;
        if (!userApiKey) {
            const unavailable = 'Thanks for your message. Our sales team will get back to you shortly.';
            await this._reply(conversation.id, incoming, unavailable, sendMessage, io, userId);
            return true;
        }

        try {
            if (/^(hi|hello|hey)\b[!. ]*$/i.test(incoming.text)) {
                await this._reply(conversation.id, incoming, `Hello! Welcome to ${businessName}. How can I help you today?`, sendMessage, io, userId);
                return true;
            }
            const context = await knowledgeBase.getRelevantContext(incoming.text, 4, userId);
            const reply = await aiService.generateReply(
                this._buildSystemPrompt(context, businessName),
                await conversationService.getHistory(conversation.id, 15, userId),
                { apiKey: userApiKey, baseURL: userBaseURL, model: userModel },
            );
            await this._reply(conversation.id, incoming, reply, sendMessage, io, userId);
        } catch (error) {
            console.error(`AI reply error for ${incoming.from} (user ${userId}):`, error.message);
            emitToUser(io, userId, 'conversation:ai_error', { conversationId: conversation.id, error: 'AI response unavailable' });
            try {
                await this._reply(conversation.id, incoming, 'Thanks for your message. Our sales team will get back to you shortly.', sendMessage, io, userId);
            } catch (replyError) {
                console.error(`Auto-reply send error for ${incoming.from}:`, replyError.message);
            }
        }
        return true;
    }

    async _reply(conversationId, incoming, body, sendMessage, io, userId) {
        await sendMessage(incoming.from, body, incoming.jid);
        await conversationService.saveMessage(conversationId, 'outbound', body, null, 'sent', { provider: incoming.provider, sender: 'business' }, userId);
        emitToUser(io, userId, 'message:new', { conversationId, provider: incoming.provider, phone: incoming.from, name: incoming.contact.name || incoming.from, body, text: body, direction: 'outbound', timestamp: Date.now(), type: 'text' });
    }

    _buildSystemPrompt(knowledgeContext, businessName = 'our business') {
        return `You are a professional AI assistant for ${businessName}. Be concise, friendly, and truthful. Never invent prices, availability, specifications, delivery dates, certifications, discounts, or warranties. If information is unavailable, say you will connect the customer with the sales team. Help with product enquiries and collect product, size, quantity, delivery location, company, and project details for quotations. Do not pretend to be human. Keep replies to 2-4 sentences.\n\n${knowledgeContext ? `COMPANY KNOWLEDGE:\n${knowledgeContext}\nUse only this company information for factual answers.` : ''}`;
    }
}

module.exports = new IncomingMessageService();
