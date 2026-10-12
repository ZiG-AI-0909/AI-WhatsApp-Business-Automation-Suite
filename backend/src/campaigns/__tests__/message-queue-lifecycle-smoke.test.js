const assert = require('assert');
const db = require('../../database/db');
const contactService = require('../../contacts/contactService');
const queue = require('../messageQueue');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function main() {
    const original = {
        getById: db.getById, update: db.update, select: db.select, count: db.count,
        findByPhone: contactService.findByPhone, process: queue._process, sender: queue._getSender,
        io: queue._io,
    };
    let releaseProcess;
    const sent = [];
    const emitted = [];
    const campaigns = new Map([
        [1, { id: 1, user_id: USER_A, name: 'first', status: 'draft', provider: 'web', settings: '{}' }],
        [2, { id: 2, user_id: USER_A, name: 'second', status: 'draft', provider: 'web', settings: '{}' }],
        [3, { id: 3, user_id: USER_B, name: 'other', status: 'draft', provider: 'web', settings: '{}' }],
    ]);
    let updates = 0;
    let getByIdDeferred = null;
    let selectInterrupted = false;
    let selectPending = false;

    db.getById = async (table, id, userId) => {
        if (getByIdDeferred && Number(id) === 3) return getByIdDeferred;
        return table === 'campaigns' && campaigns.get(Number(id))?.user_id === userId ? { ...campaigns.get(Number(id)) } : null;
    };
    db.update = async (table, data) => {
        updates += 1;
        if (updates === 1) throw new Error('planned start update failure');
        if (table === 'campaigns' && data.status === 'failed') return [];
        return [];
    };
    db.select = async (table) => {
        if (table === 'campaigns' && selectInterrupted) {
            selectInterrupted = false;
            return [{ id: 40, user_id: USER_A, name: 'restored', status: 'paused', provider: 'web', settings: '{"businessHoursEnabled":false}' }];
        }
        if (table === 'campaign_contacts' && selectPending) {
            if (selectPending === 1) {
                selectPending = 2;
                return [{
                    id: 1, campaign_id: 40, contact_id: 5, rendered_message: 'hello', status: 'pending', attempts: 0,
                    contacts: { phone: '919999000000' }, campaigns: { buttons: '[]' },
                }];
            }
            selectPending = false;
            return [];
        }
        if (table === 'campaign_contacts') return new Promise(resolve => { releaseProcess = resolve; });
        return [];
    };
    db.count = async () => 0;
    contactService.findByPhone = async () => null;
    queue.setIO({ to: room => ({ emit: (event, data) => emitted.push({ room, event, data }) }) });

    try {
        queue._queues.clear();
        queue._process = () => new Promise(resolve => { releaseProcess = resolve; });
        updates = 0;
        await assert.rejects(queue.start(1, {}, USER_A), /planned start update failure/);
        assert.strictEqual(queue.getCurrentCampaignId(USER_A), null, 'failed start releases reserved worker slot');
        await queue.start(2, {}, USER_A);
        const ownerWorker = queue._worker(USER_A);
        assert.ok(emitted.some(item => item.room === `user:${USER_A}` && item.event === 'campaign:started'));
        assert.ok(!emitted.some(item => item.room === `user:${USER_B}` && item.event === 'campaign:started'));
        await assert.rejects(queue.start(3, {}, USER_A), /already running/i);
        ownerWorker._running = false;
        releaseProcess?.([]);
        queue._queues.delete(USER_A);

        queue._queues.clear();
        let releaseGet;
        getByIdDeferred = new Promise(resolve => { releaseGet = resolve; });
        const firstStart = queue.start(3, {}, USER_B);
        await assert.rejects(queue.start(3, {}, USER_B), /already running/i, 'second start is rejected while first awaits database');
        releaseGet({ ...campaigns.get(3) });
        await firstStart;
        getByIdDeferred = null;
        const doubleStartWorker = queue._worker(USER_B);
        doubleStartWorker._running = false;
        releaseProcess?.([]);
        queue._queues.delete(USER_B);

        queue._queues.clear();
        let processRuns = 0;
        let crashingWorker;
        queue._process = async function () {
            processRuns += 1;
            if (processRuns === 1) { crashingWorker = this; throw new Error('planned processor crash'); }
            return new Promise(resolve => { releaseProcess = resolve; });
        };
        updates = 1;
        await queue.start(1, {}, USER_A);
        await crashingWorker._processPromise;
        assert.strictEqual(queue.isRunning(USER_A), false, 'crashed worker is removed');
        await queue.start(2, {}, USER_A);
        const replacement = queue._worker(USER_A);
        assert.ok(replacement, 'user can start another campaign after processor crash');
        replacement._running = false;
        releaseProcess?.([]);
        queue._queues.delete(USER_A);

        queue._queues.clear();
        queue._process = original.process;
        selectInterrupted = true;
        await queue.resumeInterrupted(null);
        assert.strictEqual(queue._worker(USER_A)._processPromise, null, 'paused restored campaign has no processor until resumed');
        selectPending = 1;
        queue._getSender = async () => async () => { sent.push(true); return { id: 'sent-message' }; };
        const restoredWorker = queue._worker(USER_A);
        restoredWorker._rateLimiter.wait = async () => { restoredWorker._running = false; };
        await queue.resume(USER_A);
        await restoredWorker._processPromise;
        assert.strictEqual(sent.length, 1, 'resume starts sending on restored paused queue');
        assert.strictEqual(queue.isRunning(), false, 'query without userId is safe and returns false');
        assert.strictEqual(queue.getCurrentCampaignId(), null, 'query without userId returns null');
        console.log('Message queue lifecycle smoke test passed');
    } finally {
        for (const worker of queue._queues.values()) worker._running = false;
        releaseProcess?.([]);
        queue._queues.clear();
        queue._process = original.process;
        queue._getSender = original.sender;
        queue._io = original.io;
        Object.assign(db, { getById: original.getById, update: original.update, select: original.select, count: original.count });
        contactService.findByPhone = original.findByPhone;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
