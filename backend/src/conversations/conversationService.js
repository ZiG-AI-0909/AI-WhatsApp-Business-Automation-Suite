const db = require('../database/db');
const contactService = require('../contacts/contactService');

class ConversationService {
    // userId is optional: the WhatsApp webhook path (Phase 2) has no request
    // context yet and creates user-less rows; route calls always pass it.
    async getOrCreate(phone, jid, phoneKnown = true, name = '', userId = null) {
        let contact = await contactService.findByPhone(phone, userId);
        if (!contact) {
            contact = await contactService.upsert(phone, { jid, name, is_lid: phoneKnown ? 0 : 1 }, userId);
        } else if (jid || name) {
            contact = await contactService.upsert(phone, { jid, name }, userId);
        }

        let conv = await db.getOne('conversations', 'contact_id', contact.id, userId);
        if (!conv) {
            const created = await db.insert('conversations', {
                contact_id: contact.id,
                last_message_at: new Date(),
                user_id: userId,
            });
            conv = created;
        }
        return { conversation: conv, contact };
    }

    async saveMessage(conversationId, direction, body, waMessageId = null, status = 'sent', metadata = {}, userId = null) {
        if (waMessageId) {
            const existing = await db.getOne('messages', 'wa_message_id', waMessageId, userId);
            if (existing) return null;
        }

        await db.insert('messages', {
            conversation_id: conversationId,
            direction,
            body,
            wa_message_id: waMessageId,
            status,
            provider: metadata.provider || '',
            sender: metadata.sender || direction,
            timestamp: metadata.timestamp || Date.now(),
            user_id: userId,
        });

        const convWhere = userId ? 'id = ? AND user_id = ?' : 'id = ?';
        const convParams = userId ? [conversationId, userId] : [conversationId];
        await db.update('conversations', {
            last_message_at: new Date(),
        }, convWhere, convParams);

        if (direction === 'inbound') {
            // Increment unread count
            const conv = await db.getById('conversations', conversationId, userId);
            if (conv) {
                await db.update('conversations', {
                    unread_count: conv.unread_count + 1,
                }, convWhere, convParams);
            }
        }
        return true;
    }

    async getMessages(conversationId, limit = 50, userId = null) {
        const where = userId ? 'conversation_id = ? AND user_id = ?' : 'conversation_id = ?';
        const params = userId ? [conversationId, userId] : [conversationId];
        const messages = await db.select('messages', '*', where, params, 'created_at', limit);
        return messages.reverse();
    }

    async getHistory(conversationId, limit = 20, userId = null) {
        const msgs = await this.getMessages(conversationId, limit, userId);
        return msgs.map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.body,
        }));
    }

    async listConversations(userId, { page = 1, limit = 30, search = '' } = {}) {
        // Search matches contacts by name/phone/company. Those columns live on
        // the contacts table, so resolve matching contact ids first and then
        // filter conversations by contact_id IN (...), both scoped by user_id.
        let where = '';
        let params = [];

        if (search) {
            const s = `%${search}%`;
            const matches = await db.select('contacts', 'id', 'user_id = ? AND (name LIKE ? OR phone LIKE ? OR company LIKE ?)', [userId, s, s, s], '', 1000, 0);
            const contactIds = matches.map((m) => m.id);
            if (contactIds.length === 0) {
                return { total: 0, page, limit, data: [] };
            }
            where = 'user_id = ? AND contact_id IN (?)';
            params = [userId, contactIds];
        }

        const offset = (page - 1) * limit;

        // Total count via db.count() (PostgREST head/count); SQL aggregate
        // syntax like "COUNT(*) as count" is not valid PostgREST select.
        // params is COPIED for the count: db.applyWhere consumes params with
        // shift(), and the same array must stay intact for the select below.
        // (Before this fix every search request 500'd with "Missing
        // parameter for condition: user_id = ?".)
        const total = where
            ? await db.count('conversations', where, params.slice())
            : await db.count('conversations', 'user_id = ?', [userId]);

        // ONE query with embedded contacts + newest message (2026-09
        // performance fix). This used to be a 2N+1 round-trip N+1 loop:
        // per conversation a contacts getById + a messages select of the
        // last body — 11+ requests for the dashboard's limit=5 poll, which
        // (plus the dashboard's own count storm) pushed the endpoint past
        // the client's 30s budget. PostgREST embeds both relations in the
        // same request: conversations.contact_id → contacts.id (FK) and
        // messages.conversation_id → conversations.id (FK, the same embed
        // the analytics recent-messages query already uses in production).
        // referencedTable order/limit keeps only each conversation's single
        // newest message instead of its entire history.
        const conversations = await db.select(
            'conversations',
            '*, contacts(name, phone, company, city, is_lid), messages(body)',
            where || 'user_id = ?',
            where ? params : [userId],
            'last_message_at',
            limit,
            offset,
            { messages: { orderBy: 'created_at', ascending: false, limit: 1 } }
        );

        const data = conversations.map((conv) => ({
            ...conv,
            name: conv.contacts?.name || '',
            phone: conv.contacts?.phone || '',
            company: conv.contacts?.company || '',
            city: conv.contacts?.city || '',
            is_lid: conv.contacts?.is_lid || 0,
            last_message: conv.messages?.length > 0 ? conv.messages[0].body : null,
            contacts: undefined,
            messages: undefined,
        }));

        return {
            total,
            page,
            limit,
            data,
        };
    }

    async getConversation(id, userId) {
        const conv = await db.getById('conversations', id, userId);
        if (!conv) return null;

        const contact = await db.getById('contacts', conv.contact_id, userId);
        return {
            ...conv,
            name: contact?.name || '',
            phone: contact?.phone || '',
            company: contact?.company || '',
            city: contact?.city || '',
            marketing_opt_in: contact?.marketing_opt_in || 1,
            jid: contact?.jid || null,
            is_lid: contact?.is_lid || 0,
        };
    }

    async setAIEnabled(conversationId, enabled, userId = null) {
        const where = userId ? 'id = ? AND user_id = ?' : 'id = ?';
        const params = userId ? [conversationId, userId] : [conversationId];
        await db.update('conversations', {
            ai_enabled: enabled ? 1 : 0,
        }, where, params);
    }

    async setStatus(conversationId, status, userId = null) {
        const where = userId ? 'id = ? AND user_id = ?' : 'id = ?';
        const params = userId ? [conversationId, userId] : [conversationId];
        await db.update('conversations', {
            status,
        }, where, params);

        if (status === 'resolved') {
            await db.update('conversations', {
                unread_count: 0,
            }, where, params);
        }
    }

    async markRead(conversationId, userId = null) {
        const where = userId ? 'id = ? AND user_id = ?' : 'id = ?';
        const params = userId ? [conversationId, userId] : [conversationId];
        await db.update('conversations', {
            unread_count: 0,
        }, where, params);
    }

    async delete(conversationId, userId) {
        await db.del('messages', 'conversation_id = ? AND user_id = ?', [conversationId, userId]);
        await db.del('conversations', 'id = ? AND user_id = ?', [conversationId, userId]);
    }

    async deleteMany(ids, userId) {
        for (const id of ids) {
            await this.delete(id, userId);
        }
    }

    async incrementReplyCount(campaignId, userId = null) {
        // Supabase doesn't support atomic increment directly
        // We need to get, increment, and update
        const campaign = await db.getById('campaigns', campaignId, userId);
        if (campaign) {
            await db.update('campaigns', {
                replies: (campaign.replies || 0) + 1,
            }, userId ? 'id = ? AND user_id = ?' : 'id = ?', userId ? [campaignId, userId] : [campaignId]);
        }
    }

    async recentActivity(userId, limit = 10) {
        // Same single-query embed as listConversations (2N+1 → 1 round trip).
        const conversations = await db.select(
            'conversations',
            '*, contacts(name, phone, company, city, is_lid), messages(body)',
            'user_id = ?',
            [userId],
            'last_message_at',
            limit,
            null,
            { messages: { orderBy: 'created_at', ascending: false, limit: 1 } }
        );

        return conversations.map((conv) => ({
            id: conv.id,
            status: conv.status,
            ai_enabled: conv.ai_enabled,
            last_message_at: conv.last_message_at,
            unread_count: conv.unread_count,
            name: conv.contacts?.name || '',
            phone: conv.contacts?.phone || '',
            company: conv.contacts?.company || '',
            last_message: conv.messages?.length > 0 ? conv.messages[0].body : null,
        }));
    }

    async stats(userId) {
        // Independent counts — run concurrently (were strictly sequential:
        // 7 round trips of wall time per /stats/overview call).
        const [total, open, resolved, humanTakeover, totalMessages, inbound, outbound] = await Promise.all([
            db.count('conversations', 'user_id = ?', [userId]),
            db.count('conversations', "user_id = ? AND status = ?", [userId, 'open']),
            db.count('conversations', "user_id = ? AND status = ?", [userId, 'resolved']),
            db.count('conversations', "user_id = ? AND status = ?", [userId, 'human_takeover']),
            db.count('messages', 'user_id = ?', [userId]),
            db.count('messages', "user_id = ? AND direction = ?", [userId, 'inbound']),
            db.count('messages', "user_id = ? AND direction = ?", [userId, 'outbound']),
        ]);

        return {
            total,
            open,
            resolved,
            humanTakeover,
            totalMessages,
            inbound,
            outbound,
        };
    }
}

module.exports = new ConversationService();