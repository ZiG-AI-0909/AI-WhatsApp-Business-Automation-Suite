const assert = require('node:assert/strict');
const db = require('../../database/db');
const queue = require('../messageQueue');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function main() {
    const original = { count: db.count, select: db.select, update: db.update, emit: queue._emit };
    const updates = [];
    const counts = { sent: 0, failed: 0, opted_out: 113, skipped: 0 };
    db.select = async () => [];
    db.count = async (_table, where, params) => {
        if (where.includes("status IN ('pending', 'processing')")) return 0;
        const status = params[2];
        return counts[status] || 0;
    };
    db.update = async (_table, data) => { updates.push(data); return []; };
    queue._emit = () => {};

    try {
        queue._queues.clear();
        await queue._process.call({
            _campaignId: 3,
            _ownerUserId: USER_ID,
            _running: true,
            _paused: false,
            _rateLimiter: null,
            _queues: queue._queues,
            _update: queue._update,
            _emit: queue._emit,
        });

        const completed = updates.find(update => update.status === 'completed');
        assert.ok(completed, 'campaign should complete after all eligible recipients are processed');
        assert.equal(completed.processed, 113, 'pre-existing opted-out recipients count as processed');
        assert.equal(completed.opt_outs, 113, 'opt-out counter reflects opted-out recipients');
        assert.equal(completed.sent, 0);
        assert.equal(completed.failed, 0);
        console.log('Message queue completion counters smoke test passed');
    } finally {
        queue._queues.clear();
        Object.assign(db, { count: original.count, select: original.select, update: original.update });
        queue._emit = original.emit;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
