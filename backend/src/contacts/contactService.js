const db = require('../database/db');
const { supabase, isAvailable } = require('../database/supabaseClient');
const { parseJsonField } = require('../utils/jsonField');
const { isCampaignDeliveryMigrationAvailable } = require('../database/campaignDeliveryMigrationGuard');

const OPT_OUT_SOURCES = new Set(['reply', 'manual', 'whatsapp']);
const OPT_OUT_HOW = {
    reply: 'by replying STOP',
    whatsapp: "through WhatsApp's marketing opt-out",
    manual: 'when it was marked opted out',
};

/** True when the contact asked to stop and has not opted in since. */
function optedOutByRequest(contact) {
    if (!contact || Number(contact.marketing_opt_in) || !contact.opted_out_at) return false;
    return !contact.opted_in_at || new Date(contact.opted_in_at) < new Date(contact.opted_out_at);
}

function optedOutError(contact) {
    const when = new Date(contact.opted_out_at).toISOString().slice(0, 10);
    const how = OPT_OUT_HOW[contact.opt_out_source] ? ` ${OPT_OUT_HOW[contact.opt_out_source]}` : '';
    return Object.assign(
        new Error(`This contact opted out on ${when}${how}. Only turn marketing messages back on if they asked to receive them again.`),
        { statusCode: 409, code: 'OPTED_OUT' },
    );
}

/**
 * Consent columns for a requested marketing_opt_in change. Opting a
 * contact back in after they asked to stop needs data.confirm_resubscribe;
 * without it this throws (or, with lenient, leaves consent unchanged).
 */
function consentChanges(existing, data, { lenient = false } = {}) {
    if (data.marketing_opt_in === undefined) return {};
    const recordConsent = isCampaignDeliveryMigrationAvailable();
    const now = new Date();
    if (!data.marketing_opt_in) {
        if (existing && Number(existing.marketing_opt_in) && recordConsent) {
            return { marketing_opt_in: 0, opted_out_at: now, opt_out_source: 'manual' };
        }
        return { marketing_opt_in: 0 };
    }
    if (existing && Number(existing.marketing_opt_in)) return {};
    if (optedOutByRequest(existing) && data.confirm_resubscribe !== true) {
        if (lenient) return {};
        throw optedOutError(existing);
    }
    return recordConsent
        ? { marketing_opt_in: 1, opted_in_at: now, opt_in_source: data.opt_in_source || 'manual' }
        : { marketing_opt_in: 1 };
}

class ContactService {
    async upsertMany(entries, userId) {
        if (!userId) throw new Error('userId is required for contact upsert');
        const result = new Map();
        const batchSize = 100;

        for (let offset = 0; offset < entries.length; offset += batchSize) {
            const batch = entries.slice(offset, offset + batchSize).map(({ phone, data = {} }) => ({
                phone: this._cleanPhone(phone),
                data,
            }));
            if (batch.some(({ phone }) => phone.length < 10 || phone.length > 15)) {
                throw new Error('Invalid phone number in contact batch');
            }

            const existingRows = await db.select(
                'contacts',
                '*',
                'user_id = ? AND phone IN (?)',
                [userId, batch.map(({ phone }) => phone)],
            );
            const existingByPhone = new Map(existingRows.map(contact => [contact.phone, contact]));
            const inserts = [];
            const updates = [];

            for (const { phone, data } of batch) {
                const existing = existingByPhone.get(phone);
                if (!existing) {
                    inserts.push({
                        phone,
                        name: data.name || '',
                        email: this._cleanEmail(data.email),
                        company: data.company || '',
                        city: data.city || '',
                        tags: JSON.stringify(data.tags || []),
                        notes: data.notes || '',
                        marketing_opt_in: data.marketing_opt_in === true ? 1 : 0,
                        ...(data.marketing_opt_in === true && isCampaignDeliveryMigrationAvailable()
                            ? { opted_in_at: new Date(), opt_in_source: data.opt_in_source || 'import' } : {}),
                        jid: data.jid || null,
                        is_lid: data.is_lid ? 1 : 0,
                        user_id: userId,
                    });
                    continue;
                }

                const changes = {};
                if (typeof data.name === 'string' && data.name.trim()) changes.name = data.name;
                if (data.email !== undefined) changes.email = this._cleanEmail(data.email);
                if (data.company !== undefined) changes.company = data.company;
                if (data.city !== undefined) changes.city = data.city;
                if (data.tags !== undefined) changes.tags = JSON.stringify(data.tags);
                if (data.notes !== undefined) changes.notes = data.notes;
                Object.assign(changes, consentChanges(existing, data, { lenient: true }));
                if (data.jid) changes.jid = data.jid;
                if (data.is_lid !== undefined) changes.is_lid = data.is_lid ? 1 : 0;
                updates.push({ phone, existing, changes });
            }

            if (inserts.length) {
                const insertedRows = await db.insertMany('contacts', inserts);
                for (const contact of insertedRows) result.set(contact.phone, this._parse(contact));
            }

            for (let i = 0; i < updates.length; i += 25) {
                await Promise.all(updates.slice(i, i + 25).map(async ({ phone, existing, changes }) => {
                    if (Object.keys(changes).length) {
                        const updated = await db.update('contacts', changes, 'phone = ? AND user_id = ?', [phone, userId]);
                        if (!updated[0]) throw new Error('Failed to update an imported contact');
                        result.set(phone, this._parse(updated[0]));
                    } else {
                        result.set(phone, this._parse(existing));
                    }
                }));
            }
        }

        return result;
    }

    async upsert(phone, data = {}, userId) {
        if (!userId) throw new Error('userId is required for contact upsert');
        const clean = this._cleanPhone(phone);
        const existing = await db.getOne('contacts', 'phone', clean, userId);

        if (existing) {
            const updates = {};
            if (typeof data.name === 'string' && data.name.trim()) updates.name = data.name;
            if (data.email !== undefined) updates.email = this._cleanEmail(data.email);
            if (data.company !== undefined) updates.company = data.company;
            if (data.city !== undefined) updates.city = data.city;
            if (data.tags !== undefined) updates.tags = JSON.stringify(data.tags);
            if (data.notes !== undefined) updates.notes = data.notes;
            Object.assign(updates, consentChanges(existing, data));
            if (data.last_message_at !== undefined) {
                updates.last_message_at = new Date(data.last_message_at);
            }
            if (data.jid) updates.jid = data.jid;
            if (data.is_lid !== undefined) updates.is_lid = data.is_lid ? 1 : 0;

            if (Object.keys(updates).length > 0) {
                const updated = await db.update('contacts', updates, 'phone = ? AND user_id = ?', [clean, userId]);
                // Get fresh data with parsed JSON
                const fresh = await db.getOne('contacts', 'phone', clean, userId);
                return this._parse(fresh);
            }
            return this._parse(existing);
        } else {
            const newContact = await db.insert('contacts', {
                phone: clean,
                name: data.name || '',
                email: this._cleanEmail(data.email),
                company: data.company || '',
                city: data.city || '',
                tags: JSON.stringify(data.tags || []),
                notes: data.notes || '',
                marketing_opt_in: data.marketing_opt_in === true ? 1 : 0,
                ...(data.marketing_opt_in === true && isCampaignDeliveryMigrationAvailable()
                    ? { opted_in_at: new Date(), opt_in_source: data.opt_in_source || 'manual' } : {}),
                jid: data.jid || null,
                is_lid: data.is_lid ? 1 : 0,
                user_id: userId,
            });
            return this._parse(newContact);
        }
    }

    findByPhone(phone, userId) {
        if (!userId) throw new Error('userId is required for contact lookup');
        return db.getOne('contacts', 'phone', this._cleanPhone(phone), userId);
    }

    findById(id, userId) {
        if (!userId) throw new Error('userId is required for contact lookup');
        return db.getById('contacts', id, userId);
    }

    async list(userId, { search = '', page = 1, limit = 50, optIn } = {}) {
        let where = 'user_id = ?';
        const params = [userId];
        if (search) {
            where += ` AND (phone LIKE ? OR name LIKE ? OR company LIKE ? OR city LIKE ? OR email LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s, s, s);
        }
        if (optIn !== undefined) {
            where += ' AND marketing_opt_in = ?';
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

    async update(id, data, userId) {
        if (!userId) throw new Error('userId is required for contact update');
        const contact = await db.getById('contacts', id, userId);
        if (!contact) return null;

        const updates = { updated_at: new Date() };
        if (data.name !== undefined) updates.name = data.name;
        if (data.email !== undefined) updates.email = this._cleanEmail(data.email);
        if (data.company !== undefined) updates.company = data.company;
        if (data.city !== undefined) updates.city = data.city;
        if (data.tags !== undefined) updates.tags = JSON.stringify(data.tags);
        if (data.notes !== undefined) updates.notes = data.notes;
        Object.assign(updates, consentChanges(contact, data));

        await db.update('contacts', updates, 'id = ? AND user_id = ?', [id, userId]);
        const updated = await db.getById('contacts', id, userId);
        return this._parse(updated);
    }

    async delete(id, userId) {
        if (!userId) throw new Error('userId is required for contact deletion');
        await db.del('contacts', 'id = ? AND user_id = ?', [id, userId]);
    }

    async deleteMany(ids, userId) {
        for (const id of ids) {
            await this.delete(id, userId);
        }
    }

    /**
     * Suppress marketing messages to this contact.
     * @param {'reply'|'manual'|'whatsapp'} source STOP reply, a user action, or
     *        WhatsApp's own marketing opt-out (Cloud API error 131050).
     */
    async setOptOut(phone, userId, source = 'manual') {
        if (!userId) throw new Error('userId is required to update contact opt-out status');
        const clean = this._cleanPhone(phone);
        const where = 'phone = ? AND user_id = ?';
        const params = [clean, userId];
        const changes = {
            marketing_opt_in: 0,
            updated_at: new Date(),
        };
        if (isCampaignDeliveryMigrationAvailable()) {
            changes.opted_out_at = new Date();
            changes.opt_out_source = OPT_OUT_SOURCES.has(source) ? source : 'manual';
        }
        await db.update('contacts', changes, where, params);
    }

    /** The contact asked to receive messages (e.g. replied START). */
    async setOptIn(phone, userId, source = 'reply') {
        if (!userId) throw new Error('userId is required to update contact opt-in status');
        const changes = { marketing_opt_in: 1, updated_at: new Date() };
        if (isCampaignDeliveryMigrationAvailable()) {
            changes.opted_in_at = new Date();
            changes.opt_in_source = source;
        }
        await db.update('contacts', changes, 'phone = ? AND user_id = ?', [this._cleanPhone(phone), userId]);
    }

    importFromArray(rows, userId) {
        const results = { added: 0, updated: 0, invalid: 0, duplicates: 0 };
        const seen = new Set();

        // This is synchronous in the original; we return a promise-like structure
        // For full async, we'd need to make this async. Keeping sync-compatible for now.
        const syncUpsert = async (row) => {
            const clean = this._cleanPhone(row.phone || '');
            if (!clean || clean.length < 10 || clean.length > 15) { results.invalid++; return; }
            if (seen.has(clean)) { results.duplicates++; return; }
            seen.add(clean);
            const existing = await db.getOne('contacts', 'phone', clean, userId);
            await this.upsert(clean, { name: row.name, email: row.email, company: row.company, city: row.city }, userId);
            if (existing) results.updated++;
            else results.added++;
        };

        return Promise.all(rows.map(syncUpsert)).then(() => results);
    }

    async stats(userId) {
        const total = await db.count('contacts', 'user_id = ?', [userId]);
        const optedOut = await db.count('contacts', 'user_id = ? AND marketing_opt_in = ?', [userId, 0]);
        return { total, optedIn: total - optedOut, optedOut };
    }

    _cleanPhone(phone) {
        return String(phone).replace(/[^\d]/g, '');
    }

    /**
     * Normalize an email address: trim, lowercase, empty string -> null.
     * Email is optional, so absence is stored as NULL rather than ''.
     * No format validation here — the UI hints at format; invalid values
     * simply never match a campaign send (Phase 2 filters them out).
     */
    _cleanEmail(email) {
        const clean = String(email || '').trim().toLowerCase() || null;
        return clean;
    }

    _parse(contact) {
        if (!contact) return contact;
        contact.tags = parseJsonField(contact.tags, []);
        return contact;
    }
}

module.exports = new ContactService();
module.exports.optedOutByRequest = optedOutByRequest;
