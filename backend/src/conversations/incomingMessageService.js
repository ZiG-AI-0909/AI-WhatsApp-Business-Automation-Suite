const db = require('../database/db');
const contactService = require('../contacts/contactService');
const conversationService = require('./conversationService');
const messageQueue = require('../campaigns/messageQueue');
const aiService = require('../ai/aiService');
const knowledgeBase = require('../ai/knowledgeBase');

const HUMAN_HANDOFF_TRIGGERS = [
    /\btalk\s*to\s*(a\s*)?(human|person|agent|someone|sales|manager|representative)\b/i,
    /\bcall\s*me\b/i, /\bsales(person|man|rep(resentative)?)?\b/i,
    /\bmanager\b/i, /\bhuman\b/i, /\bphone\s*(call|number)\b/i,
    /\bmujhe\s*(call|baat)\b/i,
];

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

    _emit(io, event, data) { io?.emit(event, data); }

    async process(input, sendMessage, io) {
        const incoming = this.normalize(input, input.provider || 'web');
        if (!incoming.from || !incoming.text || incoming.type !== 'text') return false;
        if (incoming.from.includes('@g.us') || incoming.from === 'status@broadcast') return false;

        const { conversation, contact } = conversationService.getOrCreate(incoming.from, incoming.jid, incoming.phoneKnown, incoming.contact.name);
        const saved = conversationService.saveMessage(conversation.id, 'inbound', incoming.text, incoming.messageId, 'received', {
            provider: incoming.provider, sender: incoming.from, timestamp: incoming.timestamp,
        });
        if (!saved) return false;
        this._emit(io, 'message:new', { conversationId: conversation.id, ...incoming, name: contact.name || incoming.contact.name || incoming.from, direction: 'inbound', body: incoming.text });

        if (messageQueue.constructor.isOptOut(incoming.text)) {
            contactService.setOptOut(incoming.from);
            conversationService.setStatus(conversation.id, 'resolved');
            const ack = 'You have been unsubscribed from our marketing messages. You will no longer receive promotional messages from us.';
            await this._reply(conversation.id, incoming, ack, sendMessage, io);
            return true;
        }

        if (HUMAN_HANDOFF_TRIGGERS.some((pattern) => pattern.test(incoming.text)) && conversation.ai_enabled) {
            conversationService.setAIEnabled(conversation.id, false);
            conversationService.setStatus(conversation.id, 'human_takeover');
            this._emit(io, 'conversation:human_takeover', { conversationId: conversation.id, phone: incoming.from });
            const handoff = "I understand you'd like to speak with our sales team. We've flagged your conversation and a representative will get in touch with you shortly.";
            await this._reply(conversation.id, incoming, handoff, sendMessage, io);
            return true;
        }

        if (!conversation.ai_enabled) return true;
        if (!aiService.isAvailable()) {
            const unavailable = 'Thanks for your message. Our sales team will get back to you shortly.';
            await this._reply(conversation.id, incoming, unavailable, sendMessage, io);
            return true;
        }
        try {
            if (/^(hi|hello|hey)\b[!. ]*$/i.test(incoming.text)) {
                await this._reply(conversation.id, incoming, `Hello! Welcome to Bhavesh Pipes. How can I help you today?`, sendMessage, io);
                return true;
            }
            const context = knowledgeBase.getRelevantContext(incoming.text, 4);
            const reply = await aiService.generateReply(this._buildSystemPrompt(context), conversationService.getHistory(conversation.id, 15));
            await this._reply(conversation.id, incoming, reply, sendMessage, io);
        } catch (error) {
            console.error(`AI reply error for ${incoming.from}:`, error.message);
            this._emit(io, 'conversation:ai_error', { conversationId: conversation.id, error: 'AI response unavailable' });
            try {
                await this._reply(conversation.id, incoming, 'Thanks for your message. Our sales team will get back to you shortly.', sendMessage, io);
            } catch (replyError) {
                console.error(`Auto-reply send error for ${incoming.from}:`, replyError.message);
            }
        }
        return true;
    }

    async _reply(conversationId, incoming, body, sendMessage, io) {
        await sendMessage(incoming.from, body, incoming.jid);
        conversationService.saveMessage(conversationId, 'outbound', body, null, 'sent', { provider: incoming.provider, sender: 'business' });
        this._emit(io, 'message:new', { conversationId, provider: incoming.provider, phone: incoming.from, name: incoming.contact.name || incoming.from, body, text: body, direction: 'outbound', timestamp: Date.now(), type: 'text' });
    }

    _buildSystemPrompt(knowledgeContext) {
        const businessName = process.env.BUSINESS_NAME || 'Bhavesh Pipes';
        return `You are a professional AI assistant for ${businessName}. Be concise, friendly, and truthful. Never invent prices, availability, specifications, delivery dates, certifications, discounts, or warranties. If information is unavailable, say you will connect the customer with the sales team. Help with product enquiries and collect product, size, quantity, delivery location, company, and project details for quotations. Do not pretend to be human. Keep replies to 2-4 sentences.\n\n${knowledgeContext ? `COMPANY KNOWLEDGE:\n${knowledgeContext}\nUse only this company information for factual answers.` : ''}`;
    }
}

module.exports = new IncomingMessageService();