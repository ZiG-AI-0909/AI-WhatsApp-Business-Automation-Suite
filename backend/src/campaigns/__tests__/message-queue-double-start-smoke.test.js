const assert = require('assert');
const db = require('../../database/db');
const queue = require('../messageQueue');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function main() {
    const original = { getById: db.getById, update: db.update, process: queue._process };
    let releaseRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    db.getById = async (table, id, userId) => {
        await readGate;
        return table === 'campaigns' && userId === USER_A
            ? { id: Number(id), user_id: USER_A, name: 'campaign', provider: 'web', settings: '{}' }
            : null;
    };
    db.update = async () => [];
    queue._process = async () => {};

    try {
        const first = queue.start(1, {}, USER_A);
        const second = queue.start(2, {}, USER_A);
        releaseRead();
        const results = await Promise.allSettled([first, second]);
        assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1, 'exactly one concurrent start for one owner succeeds');
        assert.strictEqual(results.filter(result => result.status === 'rejected').length, 1, 'the competing start is rejected');
        console.log('Message queue double-start smoke test passed');
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
        Object.assign(db, { getById: original.getById, update: original.update });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
