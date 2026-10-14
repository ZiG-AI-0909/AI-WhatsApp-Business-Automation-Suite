const assert = require('assert');
const db = require('../../database/db');
const queue = require('../messageQueue');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function main() {
    const original = { getById: db.getById, update: db.update, claimCampaignToRun: db.claimCampaignToRun, process: queue._process };
    let updates = 0;
    db.getById = async (table, id, userId) => table === 'campaigns' && userId === USER_A
        ? { id: Number(id), user_id: USER_A, name: 'campaign', provider: 'web', settings: '{}', status: 'draft' }
        : null;
    db.claimCampaignToRun = async (_userId, id) => {
        updates += 1;
        if (updates === 1) throw new Error('planned database failure');
        return [{ id }];
    };
    queue._process = async () => {};

    try {
        await assert.rejects(queue.start(1, {}, USER_A), /planned database failure/);
        await queue.start(2, {}, USER_A);
        console.log('Message queue start-failure smoke test passed');
    } finally {
        if (queue._queues) {
            for (const worker of queue._queues.values()) worker._running = false;
            queue._queues.clear();
        } else {
            queue._running = false;
            queue._paused = false;
            queue._campaignId = null;
            queue._ownerUserId = null;
        }
        queue._process = original.process;
        Object.assign(db, { getById: original.getById, update: original.update, claimCampaignToRun: original.claimCampaignToRun });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
