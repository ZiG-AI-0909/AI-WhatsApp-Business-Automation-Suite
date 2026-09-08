const db = require('../database/db');
const contactService = require('../contacts/contactService');

class ConversationService {
    async getOrCreate(phone, jid, phoneKnown = true, name = '') {
        let contact = await contactService.findByPhone(phone);
        if (!contact) {
            contact = await contactService.upsert(phone, { jid, name, is_lid: phoneKnown ? 0 : 1 });
        } else if (jid || name) {
            contact = await contactService.upsert(phone, { jid, name });
        }

        let conv = await db.getOne('conversations', 'contact_id', contact.id);
        if (!conv) {
            const created = await db.insert('conversations', {
                contact_id: contact.id,
                last_message_at: new Date(),
            });
            conv = created;
        }
        return { conversation: conv, contact };
    }

    async saveMessage(conversationId, direction, body, waMessageId = null, status = 'sent', metadata = {}) {
        if (waMessageId) {
            const existing = await db.getOne('messages', 'wa_message_id', waMessageId);
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
        });

        await db.update('conversations', {
            last_message_at: new Date(),
        }, 'id = ?', [conversationId]);

        if (direction === 'inbound') {
            // Increment unread count
            const conv = await db.getById('conversations', conversationId);
            if (conv) {
                await db.update('conversations', {
                    unread_count: conv.unread_count + 1,
                }, 'id = ?', [conversationId]);
            }
        }
        return true;
    }

    async getMessages(conversationId, limit = 50) {
        const messages = await db.select('messages', '*', 'conversation_id = ?', [conversationId], 'created_at', limit);
        return messages.reverse();
    }

    async getHistory(conversationId, limit = 20) {
        const msgs = await this.getMessages(conversationId, limit);
        return msgs.map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.body,
        }));
    }

    async listConversations({ page = 1, limit = 30, search = '' } = {}) {
        let where = '';
        const params = [];

        if (search) {
            where = `(c.name LIKE ? OR c.phone LIKE ? OR c.company LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s);
        }

        const offset = (page - 1) * limit;

        // Get total count
        let countWhere = '';
        if (search) {
            countWhere = `WHERE (contacts.name LIKE ? OR contacts.phone LIKE ? OR contacts.company LIKE ?)`;
        }
        const totalResult = await db.select(
            'conversations',
            'COUNT(*) as count',
            countWhere,
            search ? [s, s, s] : [],
            '',
            1,
            0
        );

        // Get conversations with contact info and last message
        // Note: This uses a JOIN which Supabase handles differently
        // For complex joins, we might need to use raw SQL or multiple queries
        const conversations = await db.select(
            'conversations',
            '*',
            where,
            params,
            'last_message_at',
            limit,
            offset
        );

        // Fetch contact details and last messages
        const data = await Promise.all(conversations.map(async (conv) => {
            const contact = await db.getById('contacts', conv.contact_id);
            const lastMsg = await db.select(
                'messages',
                'body',
                'conversation_id = ?',
                [conv.id],
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
            total: totalResult.length > 0 ? parseInt(totalResult[0].count) : 0,
            page,
            limit,
            data,
        };
    }

    async getConversation(id) {
        const conv = await db.getById('conversations', id);
        if (!conv) return null;

        const contact = await db.getById('contacts', conv.contact_id);
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

    async setAIEnabled(conversationId, enabled) {
        await db.update('conversations', {
            ai_enabled: enabled ? 1 : 0,
        }, 'id = ?', [conversationId]);
    }

    async setStatus(conversationId, status) {
        await db.update('conversations', {
            status,
        }, 'id = ?', [conversationId]);

        if (status === 'resolved') {
            await db.update('conversations', {
                unread_count: 0,
            }, 'id = ?', [conversationId]);
        }
    }

    async markRead(conversationId) {
        await db.update('conversations', {
            unread_count: 0,
        }, 'id = ?', [conversationId]);
    }

    async delete(conversationId) {
        await db.del('messages', 'conversation_id = ?', [conversationId]);
        await db.del('conversations', 'id = ?', [conversationId]);
    }

    async deleteMany(ids) {
        for (const id of ids) {
            await this.delete(id);
        }
    }

    async incrementReplyCount(campaignId) {
        // Supabase doesn't support atomic increment directly
        // We need to get, increment, and update
        const campaign = await db.getById('campaigns', campaignId);
        if (campaign) {
            await db.update('campaigns', {
                replies: (campaign.replies || 0) + 1,
            }, 'id = ?', [campaignId]);
        }
    }

    async recentActivity(limit = 10) {
        const conversations = await db.select(
            'conversations',
            '*',
            '',
            [],
            'last_message_at',
            limit
        );

        const data = await Promise.all(conversations.map(async (conv) => {
            const contact = await db.getById('contacts', conv.contact_id);
            const lastMsg = await db.select(
                'messages',
                'body',
                'conversation_id = ?',
                [conv.id],
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

    async stats() {
        const total = await db.count('conversations');
        const open = await db.count('conversations', "status = ?", ['open']);
        const resolved = await db.count('conversations', "status = ?", ['resolved']);
        const humanTakeover = await db.count('conversations', "status = ?", ['human_takeover']);
        const totalMessages = await db.count('messages');
        const inbound = await db.count('messages', "direction = ?", ['inbound']);
        const outbound = await db.count('messages', "direction = ?", ['outbound']);

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
