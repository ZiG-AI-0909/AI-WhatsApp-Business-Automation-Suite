const db = require('../database/db');
const contactService = require('../contacts/contactService');

class ConversationService {
    /**
     * Get or create a conversation for a contact phone number.
     */
    getOrCreate(phone, jid, phoneKnown = true, name = '') {
        let contact = contactService.findByPhone(phone);
        if (!contact) {
            contact = contactService.upsert(phone, { jid, name, is_lid: phoneKnown ? 0 : 1 });
        } else if (jid || name) {
            contact = contactService.upsert(phone, { jid, name });
        }
        let conv = db.prepare('SELECT * FROM conversations WHERE contact_id = ?').get(contact.id);
        if (!conv) {
            db.prepare('INSERT INTO conversations (contact_id, last_message_at) VALUES (?, datetime(\'now\'))').run(contact.id);
            conv = db.prepare('SELECT * FROM conversations WHERE contact_id = ?').get(contact.id);
        }
        return { conversation: conv, contact };
    }

    saveMessage(conversationId, direction, body, waMessageId = null, status = 'sent', metadata = {}) {
        if (waMessageId) {
            const existing = db.prepare('SELECT id FROM messages WHERE wa_message_id = ?').get(waMessageId);
            if (existing) return null;
        }
        db.prepare(`
            INSERT INTO messages (conversation_id, direction, body, wa_message_id, status, provider, sender, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(conversationId, direction, body, waMessageId, status, metadata.provider || '', metadata.sender || direction, metadata.timestamp || Date.now());

        db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(conversationId);

        if (direction === 'inbound') {
            db.prepare('UPDATE conversations SET unread_count = unread_count + 1 WHERE id = ?').run(conversationId);
        }
        return true;
    }

    getMessages(conversationId, limit = 50) {
        return db.prepare(`
            SELECT * FROM messages WHERE conversation_id = ?
            ORDER BY created_at DESC LIMIT ?
        `).all(conversationId, limit).reverse();
    }

    getHistory(conversationId, limit = 20) {
        const msgs = this.getMessages(conversationId, limit);
        return msgs.map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.body,
        }));
    }

    listConversations({ page = 1, limit = 30, search = '' } = {}) {
        let where = '';
        const params = [];
        if (search) {
            where = `WHERE (c.name LIKE ? OR c.phone LIKE ? OR c.company LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s);
        }
        const offset = (page - 1) * limit;
        const total = db.prepare(`
            SELECT COUNT(*) as count FROM conversations cv
            JOIN contacts c ON c.id = cv.contact_id ${where}
        `).get(...params).count;

        const rows = db.prepare(`
            SELECT cv.*, c.name, c.phone, c.company, c.city, c.is_lid,
                   (SELECT body FROM messages WHERE conversation_id=cv.id ORDER BY created_at DESC LIMIT 1) as last_message
            FROM conversations cv
            JOIN contacts c ON c.id = cv.contact_id
            ${where}
            ORDER BY cv.last_message_at DESC NULLS LAST
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        return { total, page, limit, data: rows };
    }

    getConversation(id) {
        return db.prepare(`
            SELECT cv.*, c.name, c.phone, c.company, c.city, c.marketing_opt_in, c.jid, c.is_lid
            FROM conversations cv
            JOIN contacts c ON c.id = cv.contact_id
            WHERE cv.id = ?
        `).get(id);
    }

    setAIEnabled(conversationId, enabled) {
        db.prepare('UPDATE conversations SET ai_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, conversationId);
    }

    setStatus(conversationId, status) {
        db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, conversationId);
        if (status === 'resolved') {
            db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conversationId);
        }
    }

    markRead(conversationId) {
        db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conversationId);
    }

    delete(conversationId) {
        db.exec('BEGIN');
        try {
            db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
            db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    deleteMany(ids) {
        db.exec('BEGIN');
        try {
            for (const id of ids) {
                db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
                db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    incrementReplyCount(campaignId) {
        db.prepare("UPDATE campaigns SET replies = replies + 1 WHERE id = ?").run(campaignId);
    }

    recentActivity(limit = 10) {
        return db.prepare(`
            SELECT cv.id, cv.status, cv.ai_enabled, cv.last_message_at, cv.unread_count,
                   c.name, c.phone, c.company,
                   (SELECT body FROM messages WHERE conversation_id=cv.id ORDER BY created_at DESC LIMIT 1) as last_message
            FROM conversations cv
            JOIN contacts c ON c.id = cv.contact_id
            ORDER BY cv.last_message_at DESC NULLS LAST
            LIMIT ?
        `).all(limit);
    }

    stats() {
        const total = db.prepare('SELECT COUNT(*) as c FROM conversations').get().c;
        const open = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE status = 'open'").get().c;
        const resolved = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE status = 'resolved'").get().c;
        const humanTakeover = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE status = 'human_takeover'").get().c;
        const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
        const inbound = db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'inbound'").get().c;
        const outbound = db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'outbound'").get().c;
        return { total, open, resolved, humanTakeover, totalMessages, inbound, outbound };
    }
}

module.exports = new ConversationService();
