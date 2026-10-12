const assert = require('assert');
const db = require('../../database/db');
const messageQueue = require('../messageQueue');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function main() {
    const originals = { getById: db.getById, update: db.update, select: db.select, count: db.count, pageSize: messageQueue._resumePageSize };
    const stopped = [];
    const pendingContacts = [];
    const startCampaigns = new Map([
        [10, { id: 10, user_id: USER_A, name: 'A1', provider: 'web', settings: '{}' }],
        [11, { id: 11, user_id: USER_A, name: 'A2', provider: 'web', settings: '{}' }],
        [20, { id: 20, user_id: USER_B, name: 'B1', provider: 'web', settings: '{}' }],
    ]);
    db.getById = async (table, id, userId) => table === 'campaigns' && startCampaigns.get(Number(id))?.user_id === userId ? startCampaigns.get(Number(id)) : null;
    db.update = async (table, data, where, params) => {
        if (table === 'campaigns' && data.status === 'stopped') stopped.push(params[0]);
        return [];
    };
    const interruptedRows = [
            { id: 1, user_id: USER_A, status: 'running', provider: 'web', settings: '{}' },
            { id: 2, user_id: USER_A, status: 'paused', provider: 'web', settings: '{}' },
            { id: 3, user_id: USER_A, status: 'running', provider: 'web', settings: '{}' },
            { id: 4, user_id: USER_B, status: 'running', provider: 'web', settings: '{}' },
    ];
    db.select = async (table, _columns, _where, _params, _order, limit, offset) => {
        if (table === 'campaigns') return interruptedRows.slice(offset, offset + limit);
        if (table === 'campaign_contacts') return new Promise(resolve => pendingContacts.push(resolve));
        return [];
    };
    db.count = async () => 0;

    try {
        messageQueue._queues.clear();
        messageQueue._resumePageSize = 2;
        await Promise.all([
            messageQueue.start(10, {}, USER_A),
            messageQueue.start(20, {}, USER_B),
        ]);
        assert.strictEqual(messageQueue.getCurrentCampaignId(USER_A), 10);
        assert.strictEqual(messageQueue.getCurrentCampaignId(USER_B), 20);
        await assert.rejects(messageQueue.start(11, {}, USER_A), /already running/i);

        const initialWorkers = [...messageQueue._queues.values()];
        await Promise.all(initialWorkers.map(worker => messageQueue.stop(worker._ownerUserId)));
        for (const finish of pendingContacts.splice(0)) finish([]);
        await Promise.all(initialWorkers.map(worker => worker._processPromise));
        messageQueue._queues.clear();
        await messageQueue.resumeInterrupted(null);
        assert.strictEqual(messageQueue.getCurrentCampaignId(USER_A), 1, 'oldest campaign is resumed for A');
        assert.strictEqual(messageQueue.getCurrentCampaignId(USER_B), 4, 'B campaign is resumed independently');
        assert.ok(stopped.includes(2), 'additional campaign for A is marked stopped');
        assert.ok(stopped.includes(3), 'third interrupted A campaign on the next page is marked stopped');
    } finally {
        const workers = [...messageQueue._queues.values()];
        await Promise.all(workers.map(worker => messageQueue.stop(worker._ownerUserId)));
        for (const finish of pendingContacts) finish([]);
        await Promise.all(workers.map(worker => worker._processPromise).filter(Boolean));
        messageQueue._queues.clear();
        messageQueue._resumePageSize = originals.pageSize;
        Object.assign(db, originals);
    }
    console.log('Campaign concurrency smoke test passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
