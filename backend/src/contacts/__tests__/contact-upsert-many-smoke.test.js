const assert = require('node:assert/strict');
const db = require('../../database/db');
const contactService = require('../contactService');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EXISTING_PHONE = '9000000000';

async function main() {
    const originals = { select: db.select, insertMany: db.insertMany, update: db.update };
    const insertedBatches = [];
    const updates = [];
    const entries = Array.from({ length: 101 }, (_, index) => ({
        phone: String(9000000000 + index),
        data: { name: `Contact ${index}`, company: 'Example', city: 'Bengaluru' },
    }));

    db.select = async (_table, _columns, where, params) => {
        assert.equal(where, 'user_id = ? AND phone IN (?)');
        assert.equal(params[0], USER_ID);
        if (params[1].includes(EXISTING_PHONE)) {
            return [{
                id: 12,
                user_id: USER_ID,
                phone: EXISTING_PHONE,
                name: 'Old name',
                company: 'Old company',
                city: 'Old city',
                marketing_opt_in: 0,
                tags: '[]',
            }];
        }
        return [];
    };
    db.insertMany = async (table, rows) => {
        insertedBatches.push({ table, rows });
        return rows.map((row, index) => ({ ...row, id: 100 + index }));
    };
    db.update = async (table, data, where, params) => {
        updates.push({ table, data, where, params });
        return [{ id: 12, phone: EXISTING_PHONE, marketing_opt_in: 0, ...data }];
    };

    try {
        const contacts = await contactService.upsertMany(entries, USER_ID);
        assert.equal(contacts.size, 101);
        assert.equal(insertedBatches.length, 2);
        assert.deepEqual(insertedBatches.map(batch => batch.rows.length), [99, 1]);
        assert.ok(insertedBatches.every(batch => batch.table === 'contacts'));
        assert.ok(insertedBatches.flatMap(batch => batch.rows).every(contact => contact.marketing_opt_in === 0), 'new contacts require explicit opt-in');
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0], {
            table: 'contacts',
            data: { name: 'Contact 0', company: 'Example', city: 'Bengaluru' },
            where: 'phone = ? AND user_id = ?',
            params: [EXISTING_PHONE, USER_ID],
        });
        assert.equal(contacts.get(EXISTING_PHONE).marketing_opt_in, 0, 'existing opt-out state is preserved');
        assert.equal(contacts.get('9000000001').name, 'Contact 1');
        console.log('Contact bulk upsert smoke test passed');
    } finally {
        Object.assign(db, originals);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
