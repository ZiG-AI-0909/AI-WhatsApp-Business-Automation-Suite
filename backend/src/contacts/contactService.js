const db = require('../database/db');

class ContactService {
    upsert(phone, data = {}) {
        const clean = this._cleanPhone(phone);
        const existing = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(clean);
        if (existing) {
            const fields = [];
            const values = [];
            if (typeof data.name === 'string' && data.name.trim()) { fields.push('name = ?'); values.push(data.name); }
            if (data.company !== undefined) { fields.push('company = ?'); values.push(data.company); }
            if (data.city !== undefined) { fields.push('city = ?'); values.push(data.city); }
            if (data.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(data.tags)); }
            if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
            if (data.marketing_opt_in !== undefined) { fields.push('marketing_opt_in = ?'); values.push(data.marketing_opt_in ? 1 : 0); }
            if (data.last_message_at !== undefined) { fields.push('last_message_at = ?'); values.push(data.last_message_at); }
            if (data.jid) { fields.push('jid = ?'); values.push(data.jid); }
            fields.push("updated_at = datetime('now')");
            if (fields.length > 1) {
                db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE phone = ?`).run(...values, clean);
            }
            return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(clean);
        } else {
            db.prepare(`
                INSERT INTO contacts (phone, name, company, city, tags, notes, marketing_opt_in, jid, is_lid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                clean,
                data.name || '',
                data.company || '',
                data.city || '',
                JSON.stringify(data.tags || []),
                data.notes || '',
                data.marketing_opt_in !== false ? 1 : 0,
                data.jid || null,
                data.is_lid ? 1 : 0
            );
            return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(clean);
        }
    }

    findByPhone(phone) {
        return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(this._cleanPhone(phone));
    }

    findById(id) {
        return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    }

    list({ search = '', page = 1, limit = 50, optIn } = {}) {
        let where = 'WHERE 1=1';
        const params = [];
        if (search) {
            where += ' AND (phone LIKE ? OR name LIKE ? OR company LIKE ? OR city LIKE ?)';
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }
        if (optIn !== undefined) {
            where += ' AND marketing_opt_in = ?';
            params.push(optIn ? 1 : 0);
        }
        const offset = (page - 1) * limit;
        const total = db.prepare(`SELECT COUNT(*) as count FROM contacts ${where}`).get(...params).count;
        const rows = db.prepare(`SELECT * FROM contacts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        return { total, page, limit, data: rows.map(this._parse) };
    }

    update(id, data) {
        const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
        if (!contact) return null;
        const fields = ["updated_at = datetime('now')"];
        const values = [];
        if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
        if (data.company !== undefined) { fields.push('company = ?'); values.push(data.company); }
        if (data.city !== undefined) { fields.push('city = ?'); values.push(data.city); }
        if (data.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(data.tags)); }
        if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
        if (data.marketing_opt_in !== undefined) { fields.push('marketing_opt_in = ?'); values.push(data.marketing_opt_in ? 1 : 0); }
        db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
        return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    }

    delete(id) {
        db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    }

    deleteMany(ids) {
        db.exec('BEGIN');
        try {
            for (const id of ids) db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    setOptOut(phone) {
        const clean = this._cleanPhone(phone);
        db.prepare("UPDATE contacts SET marketing_opt_in = 0, updated_at = datetime('now') WHERE phone = ?").run(clean);
    }

    importFromArray(rows) {
        const results = { added: 0, updated: 0, invalid: 0, duplicates: 0 };
        const seen = new Set();
        for (const row of rows) {
            const clean = this._cleanPhone(row.phone || '');
            if (!clean || clean.length < 10 || clean.length > 15) { results.invalid++; continue; }
            if (seen.has(clean)) { results.duplicates++; continue; }
            seen.add(clean);
            const existing = db.prepare('SELECT id FROM contacts WHERE phone = ?').get(clean);
            if (existing) results.duplicates++;
            this.upsert(clean, { name: row.name, company: row.company, city: row.city });
            if (existing) results.updated++; else results.added++;
        }
        return results;
    }

    stats() {
        const total = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
        const optedOut = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE marketing_opt_in = 0').get().c;
        return { total, optedIn: total - optedOut, optedOut };
    }

    _cleanPhone(phone) {
        return String(phone).replace(/[^\d]/g, '');
    }

    _parse(contact) {
        try { contact.tags = JSON.parse(contact.tags || '[]'); } catch { contact.tags = []; }
        return contact;
    }
}

module.exports = new ContactService();
