const db = require('../database/db');

class TemplateService {
    list() {
        return db.prepare('SELECT * FROM templates ORDER BY name ASC').all();
    }

    get(id) {
        return db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    }

    create(name, content) {
        const result = db.prepare(
            "INSERT INTO templates (name, content) VALUES (?, ?)"
        ).run(name.trim(), content.trim());
        return this.get(result.lastInsertRowid);
    }

    update(id, name, content) {
        db.prepare(
            "UPDATE templates SET name=?, content=?, updated_at=datetime('now') WHERE id=?"
        ).run(name.trim(), content.trim(), id);
        return this.get(id);
    }

    duplicate(id) {
        const t = this.get(id);
        if (!t) return null;
        return this.create(`${t.name} (copy)`, t.content);
    }

    delete(id) {
        db.prepare('DELETE FROM templates WHERE id=?').run(id);
    }

    deleteMany(ids) {
        db.exec('BEGIN');
        try {
            for (const id of ids) db.prepare('DELETE FROM templates WHERE id=?').run(id);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Extract all {{field}} placeholders from a template string.
     */
    extractFields(content) {
        const matches = content.match(/\{\{(\w+)\}\}/g) || [];
        return [...new Set(matches.map(m => m.slice(2, -2)))];
    }
}

module.exports = new TemplateService();
