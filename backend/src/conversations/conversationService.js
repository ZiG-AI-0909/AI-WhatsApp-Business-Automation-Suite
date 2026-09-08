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
        const total = where
            ? await db.count('conversations', where, params)
            : await db.count('conversations', 'user_id = ?', [userId]);

        const conversations = await db.select(
            'conversations',
            '*',
            where || 'user_id = ?',
            where ? params : [userId],
            'last_message_at',
            limit,
            offset
        );

        // Fetch contact details and last messages
        const data = await Promise.all(conversations.map(async (conv) => {
            const contact = await db.getById('contacts', conv.contact_id, userId);
            const lastMsg = await db.select(
                'messages',
                'body',
                'conversation_id = ? AND user_id = ?',
                [conv.id, userId],
                'created_at',
                1,
                0
            );
            return {
                ...conv,
                name: contact?.name || '',
                phone: contact?.phone || '',
                company: contact?.company || '',
                city: contact?.city || '',
                is_lid: contact?.is_lid || 0,
                last_message: lastMsg.length > 0 ? lastMsg[0].body : null,
            };
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
        const conversations = await db.select(
            'conversations',
            '*',
            'user_id = ?',
            [userId],
            'last_message_at',
            limit
        );

        const data = await Promise.all(conversations.map(async (conv) => {
            const contact = await db.getById('contacts', conv.contact_id, userId);
            const lastMsg = await db.select(
                'messages',
                'body',
                'conversation_id = ? AND user_id = ?',
                [conv.id, userId],
                'created_at',
                1,
                0
            );
            return {
                id: conv.id,
                status: conv.status,
                ai_enabled: conv.ai_enabled,
                last_message_at: conv.last_message_at,
                unread_count: conv.unread_count,
                name: contact?.name || '',
                phone: contact?.phone || '',
                company: contact?.company || '',
                last_message: lastMsg.length > 0 ? lastMsg[0].body : null,
            };
        }));

        return data;
    }

    async stats(userId) {
        const total = await db.count('conversations', 'user_id = ?', [userId]);
        const open = await db.count('conversations', "user_id = ? AND status = ?", [userId, 'open']);
        const resolved = await db.count('conversations', "user_id = ? AND status = ?", [userId, 'resolved']);
        const humanTakeover = await db.count('conversations', "user_id = ? AND status = ?", [userId, 'human_takeover']);
        const totalMessages = await db.count('messages', 'user_id = ?', [userId]);
        const inbound = await db.count('messages', "user_id = ? AND direction = ?", [userId, 'inbound']);
        const outbound = await db.count('messages', "user_id = ? AND direction = ?", [userId, 'outbound']);

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