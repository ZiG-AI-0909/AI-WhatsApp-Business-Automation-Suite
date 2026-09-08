const db = require('../database/db');
const { supabase, isAvailable } = require('../database/supabaseClient');

class ContactService {
    async upsert(phone, data = {}) {
        const clean = this._cleanPhone(phone);
        const existing = await db.getOne('contacts', 'phone', clean);

        if (existing) {
            const updates = {};
            if (typeof data.name === 'string' && data.name.trim()) updates.name = data.name;
            if (data.company !== undefined) updates.company = data.company;
            if (data.city !== undefined) updates.city = data.city;
            if (data.tags !== undefined) updates.tags = JSON.stringify(data.tags);
            if (data.notes !== undefined) updates.notes = data.notes;
            if (data.marketing_opt_in !== undefined) updates.marketing_opt_in = data.marketing_opt_in ? 1 : 0;
            if (data.last_message_at !== undefined) {
                updates.last_message_at = new Date(data.last_message_at);
            }
            if (data.jid) updates.jid = data.jid;
            if (data.is_lid !== undefined) updates.is_lid = data.is_lid ? 1 : 0;

            if (Object.keys(updates).length > 0) {
                const updated = await db.update('contacts', updates, 'phone = ?', [clean]);
                // Get fresh data with parsed JSON
                const fresh = await db.getOne('contacts', 'phone', clean);
                return this._parse(fresh);
            }
            return this._parse(existing);
        } else {
            const newContact = await db.insert('contacts', {
                phone: clean,
                name: data.name || '',
                company: data.company || '',
                city: data.city || '',
                tags: JSON.stringify(data.tags || []),
                notes: data.notes || '',
                marketing_opt_in: data.marketing_opt_in !== false ? 1 : 0,
                jid: data.jid || null,
                is_lid: data.is_lid ? 1 : 0,
            });
            return this._parse(newContact);
        }
    }

    findByPhone(phone) {
        return db.getOne('contacts', 'phone', this._cleanPhone(phone));
    }

    findById(id) {
        return db.getById('contacts', id);
    }

    async list({ search = '', page = 1, limit = 50, optIn } = {}) {
        let where = '';
        const params = [];
        if (search) {
            where = `(phone LIKE ? OR name LIKE ? OR company LIKE ? OR city LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }
        if (optIn !== undefined) {
            where = where ? `${where} AND marketing_opt_in = ?` : 'marketing_opt_in = ?';
            params.push(optIn ? 1 : 0);
        }
        const offset = (page - 1) * limit;

        const result = await db.paginate('contacts', where, params, 'updated_at', 'desc', limit, offset);
        return {
            total: result.total,
            page,
            limit,
            data: result.data.map(this._parse),
        };
    }

    async update(id, data) {
        const contact = await db.getById('contacts', id);
        if (!contact) return null;

        const updates = { updated_at: new Date() };
        if (data.name !== undefined) updates.name = data.name;
        if (data.company !== undefined) updates.company = data.company;
        if (data.city !== undefined) updates.city = data.city;
        if (data.tags !== undefined) updates.tags = JSON.stringify(data.tags);
        if (data.notes !== undefined) updates.notes = data.notes;
        if (data.marketing_opt_in !== undefined) updates.marketing_opt_in = data.marketing_opt_in ? 1 : 0;

        await db.update('contacts', updates, 'id = ?', [id]);
        const updated = await db.getById('contacts', id);
        return this._parse(updated);
    }

    async delete(id) {
        await db.del('contacts', 'id = ?', [id]);
    }

    async deleteMany(ids) {
        for (const id of ids) {
            await db.del('contacts', 'id = ?', [id]);
        }
    }

    async setOptOut(phone) {
        const clean = this._cleanPhone(phone);
        await db.update('contacts', {
            marketing_opt_in: 0,
            updated_at: new Date(),
        }, 'phone = ?', [clean]);
    }

    importFromArray(rows) {
        const results = { added: 0, updated: 0, invalid: 0, duplicates: 0 };
        const seen = new Set();

        // This is synchronous in the original; we return a promise-like structure
        // For full async, we'd need to make this async. Keeping sync-compatible for now.
        const syncUpsert = async (row) => {
            const clean = this._cleanPhone(row.phone || '');
            if (!clean || clean.length < 10 || clean.length > 15) { results.invalid++; return; }
            if (seen.has(clean)) { results.duplicates++; return; }
            seen.add(clean);
            const existing = await db.getOne('contacts', 'phone', clean);
            await this.upsert(clean, { name: row.name, company: row.company, city: row.city });
            if (existing) results.updated++;
            else results.added++;
        };

        return Promise.all(rows.map(syncUpsert)).then(() => results);
    }

    async stats() {
        const total = await db.count('contacts');
        const optedOut = await db.count('contacts', 'marketing_opt_in = ?', [0]);
        return { total, optedIn: total - optedOut, optedOut };
    }

    _cleanPhone(phone) {
        return String(phone).replace(/[^\d]/g, '');
    }

    _parse(contact) {
        if (!contact) return contact;
        try { contact.tags = JSON.parse(contact.tags || '[]'); } catch { contact.tags = []; }
        return contact;
    }
}

module.exports = new ContactService();
