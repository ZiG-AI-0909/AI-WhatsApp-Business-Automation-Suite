const assert = require('node:assert/strict');
const RateLimiter = require('../rateLimiter');
const queue = require('../messageQueue');

async function main() {
    const limiter = new RateLimiter();
    assert.equal(limiter.settings.maxPerHour, 50);
    assert.equal(limiter.settings.maxPerDay, 175);

    const calls = [];
    const db = {
        count: async (table, where, params) => {
            calls.push({ table, where, params });
            return params[2].getTime() < Date.now() - 12 * 3600000 ? 175 : 50;
        },
    };
    const hourlyLimited = await limiter.checkDatabaseLimits(db, 'owner-1');
    assert.equal(hourlyLimited.allowed, false);
    assert.equal(hourlyLimited.reason, 'Hourly limit reached');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.table === 'campaign_contacts' && call.where.includes('user_id = ?') && call.where.includes('sent_at >= ?')));
    assert.ok(calls.every(call => call.params[0] === 'owner-1' && call.params[1] === 'sent'));

    limiter.updateSettings({ maxPerHour: 2, maxPerDay: 3, delayBetweenMessages: 9000 });
    assert.equal(limiter.settings.maxPerHour, 2);
    assert.equal(limiter.settings.maxPerDay, 3);
    assert.equal(limiter.settings.delayBetweenMessages, 9000);
    assert.ok(limiter.nextDelayMs() >= 6300 && limiter.nextDelayMs() <= 12600);

    const worker = Object.create(queue);
    worker._running = true;
    worker._paused = false;
    const sleepCalls = [];
    worker._sleep = async milliseconds => {
        sleepCalls.push(milliseconds);
        worker._running = false;
    };
    await worker._sleepResponsive(24 * 3600000);
    assert.deepEqual(sleepCalls, [1000], 'a stop interrupts a long business-hours wait within one poll');
    console.log('Rate limiter persistence smoke test passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
