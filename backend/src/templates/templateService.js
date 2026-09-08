const db = require('../database/db');

class TemplateService {
    async list(userId) {
        const templates = await db.select('templates', '*', 'user_id = ?', [userId], 'name', 1000, 0);
        return templates.map(t => ({
            ...t,
            created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
            updated_at: t.updated_at ? new Date(t.updated_at).toISOString() : null,
        }));
    }

    async get(id, userId) {
        const t = await db.getById('templates', id, userId);
        if (!t) return null;
        return {
            ...t,
            created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
            updated_at: t.updated_at ? new Date(t.updated_at).toISOString() : null,
        };
    }

    async create(userId, name, content) {
        const created = await db.insert('templates', {
            name: name.trim(),
            content: content.trim(),
            user_id: userId,
        });
        return this.get(created.id, userId);
    }

    async update(id, name, content, userId) {
        const updated = await db.update('templates', {
            name: name.trim(),
            content: content.trim(),
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [id, userId]);
        if (!updated || updated.length === 0) return null;
        return this.get(id, userId);
    }

    async duplicate(id, userId) {
        const t = await this.get(id, userId);
        if (!t) return null;
        return this.create(userId, `${t.name} (copy)`, t.content);
    }

    async delete(id, userId) {
        await db.del('templates', 'id = ? AND user_id = ?', [id, userId]);
    }

    async deleteMany(ids, userId) {
        for (const id of ids) {
            await this.delete(id, userId);
        }
    }

    extractFields(content) {
        const matches = content.match(/\{\{(\w+)\}\}/g) || [];
        return [...new Set(matches.map(m => m.slice(2, -2)))];
    }
}

module.exports = new TemplateService();