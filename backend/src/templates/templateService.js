const db = require('../database/db');

class TemplateService {
    async list() {
        const templates = await db.select('templates', '*', '', [], 'name', 1000, 0);
        return templates.map(t => ({
            ...t,
            created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
            updated_at: t.updated_at ? new Date(t.updated_at).toISOString() : null,
        }));
    }

    async get(id) {
        const t = await db.getById('templates', id);
        if (!t) return null;
        return {
            ...t,
            created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
            updated_at: t.updated_at ? new Date(t.updated_at).toISOString() : null,
        };
    }

    async create(name, content) {
        const created = await db.insert('templates', {
            name: name.trim(),
            content: content.trim(),
        });
        return this.get(created.id);
    }

    async update(id, name, content) {
        await db.update('templates', {
            name: name.trim(),
            content: content.trim(),
            updated_at: new Date(),
        }, 'id = ?', [id]);
        return this.get(id);
    }

    async duplicate(id) {
        const t = await this.get(id);
        if (!t) return null;
        return this.create(`${t.name} (copy)`, t.content);
    }

    async delete(id) {
        await db.del('templates', 'id = ?', [id]);
    }

    async deleteMany(ids) {
        for (const id of ids) {
            await this.delete(id);
        }
    }

    extractFields(content) {
        const matches = content.match(/\{\{(\w+)\}\}/g) || [];
        return [...new Set(matches.map(m => m.slice(2, -2)))];
    }
}

module.exports = new TemplateService();
