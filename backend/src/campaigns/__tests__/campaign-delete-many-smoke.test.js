const assert = require('assert');
const db = require('../../database/db');
const campaignService = require('../campaignService');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function main() {
    const original = { getById: db.getById, update: db.update, del: db.del };
    const deletedIds = [];
    db.getById = async (table, id, userId) => {
        if (table !== 'campaigns') return null;
        if (Number(id) === 1 && userId === USER_A) return { id: 1, user_id: USER_A, status: 'draft' };
        if (Number(id) === 2 && userId === USER_B) return { id: 2, user_id: USER_B, status: 'draft' };
        return null;
    };
    db.update = async () => [];
    db.del = async (_table, _where, params) => { deletedIds.push(params[0]); return []; };
    try {
        const result = await campaignService.deleteMany([1, 2, 3], USER_A);
        assert.deepStrictEqual(result, { deleted: [1], skipped: [2, 3] });
        assert.deepStrictEqual(deletedIds, [1], 'only the owned campaign is deleted');
        console.log('Campaign bulk-delete smoke test passed');
    } finally {
        Object.assign(db, original);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
