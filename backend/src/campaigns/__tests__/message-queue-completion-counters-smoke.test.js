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
        const runScenario = async (campaignId, values) => {
            Object.assign(counts, values);
            updates.length = 0;
            queue._queues.clear();
            await queue._process.call({
                _campaignId: campaignId,
                _ownerUserId: USER_ID,
                _running: true,
                _paused: false,
                _rateLimiter: null,
                _queues: queue._queues,
                _update: queue._update,
                _emit: queue._emit,
            });
            return updates.find(update => ['completed', 'failed', 'completed_with_errors'].includes(update.status));
        };

        const noSuccessfulSends = await runScenario(3, { sent: 0, failed: 0, opted_out: 113, skipped: 0 });
        assert.equal(noSuccessfulSends.status, 'failed', 'campaign with zero successful sends never reports completed');
        assert.equal(noSuccessfulSends.processed, 113, 'pre-existing opted-out recipients count as processed');
        assert.equal(noSuccessfulSends.opt_outs, 113, 'opt-out counter reflects opted-out recipients');
        assert.equal(noSuccessfulSends.last_error, 'No messages were sent; all contacts were skipped or opted out.');
        const allFailed = await runScenario(4, { sent: 0, failed: 2, opted_out: 0, skipped: 0 });
        assert.equal(allFailed.status, 'failed');
        const mixed = await runScenario(5, { sent: 1, failed: 1, opted_out: 0, skipped: 0 });
        assert.equal(mixed.status, 'completed_with_errors');
        const success = await runScenario(6, { sent: 2, failed: 0, opted_out: 1, skipped: 0 });
        assert.equal(success.status, 'completed');
        console.log('Message queue completion counters smoke test passed');
    } finally {
        queue._queues.clear();
        Object.assign(db, { count: original.count, select: original.select, update: original.update });
        queue._emit = original.emit;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
