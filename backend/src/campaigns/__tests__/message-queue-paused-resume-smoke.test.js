const assert = require('assert');
const db = require('../../database/db');
const queue = require('../messageQueue');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function main() {
    const original = { select: db.select, update: db.update, process: queue._process };
    let processStarted = false;
    db.select = async table => table === 'campaigns'
        ? [{ id: 40, user_id: USER_A, name: 'restored', status: 'paused', provider: 'web', settings: '{}' }]
        : [];
    db.update = async () => [];
    queue._process = async () => { processStarted = true; };

    try {
        if (queue._queues) queue._queues.clear();
        await queue.resumeInterrupted(null);
        await queue.resume(USER_A);
        assert.strictEqual(processStarted, true, 'resuming a restored paused campaign starts its processor');
        console.log('Message queue paused-resume smoke test passed');
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
        Object.assign(db, { select: original.select, update: original.update });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
