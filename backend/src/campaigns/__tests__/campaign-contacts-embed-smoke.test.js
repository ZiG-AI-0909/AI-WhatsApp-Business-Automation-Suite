const assert = require('node:assert/strict');
const db = require('../../database/db');
const campaignService = require('../campaignService');

async function main() {
    const original = { count: db.count, select: db.select };
    let selectArgs;
    db.count = async (_table, _where, params) => {
        params.splice(0, params.length);
        return 1;
    };
    db.select = async (...args) => {
        selectArgs = args;
        return [{
            id: 9,
            campaign_id: 3,
            contact_id: 6,
            status: 'pending',
            contacts: { phone: '919999000000', name: 'Customer', company: 'Example', city: 'Bengaluru' },
        }];
    };

    try {
        const result = await campaignService.getContacts(3, 'user-1', { page: 1, limit: 100 });
        assert.equal(selectArgs[0], 'campaign_contacts');
        assert.match(selectArgs[1], /contacts\(phone, name, company, city\)/);
        assert.deepEqual(selectArgs[2], 'campaign_id = ? AND user_id = ?');
        assert.deepEqual(selectArgs[3], [3, 'user-1']);
        assert.equal(result.total, 1);
        assert.equal(result.data[0].phone, '919999000000');
        assert.equal(result.data[0].name, 'Customer');
        assert.equal(result.data[0].company, 'Example');
        assert.equal(result.data[0].city, 'Bengaluru');
        console.log('Campaign contact embed smoke test passed');
    } finally {
        Object.assign(db, original);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
