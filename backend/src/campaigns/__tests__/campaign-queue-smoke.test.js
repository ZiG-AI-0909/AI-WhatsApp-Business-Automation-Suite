const assert = require('node:assert/strict');
const db = require('../../database/db');
const queue = require('../messageQueue');
const campaignMediaStorage = require('../campaignMediaStorage');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function main() {
    const original = {
        getById: db.getById,
        select: db.select,
        update: db.update,
        count: db.count,
        recountCampaignCounters: db.recountCampaignCounters,
        claimCampaignToRun: db.claimCampaignToRun,
        startProcessor: queue._startProcessor,
        ownerIsConnected: queue._ownerIsConnected,
        downloadCampaignMedia: campaignMediaStorage.downloadCampaignMedia,
        io: queue._io,
    };
    const campaigns = new Map();
    const started = [];
    const events = [];
    let counters = { sent: 1, failed: 0, opt_outs: 0, skipped: 0, processed: 1 };
    let claimCount = 0;
    const createCampaign = (id, userId, status, queuePosition = null) => {
        const campaign = {
            id, user_id: userId, status, provider: 'web', name: `campaign-${id}`,
            settings: { businessHoursEnabled: false }, total_contacts: 1,
            queue_position: queuePosition, media_path: null,
        };
        campaigns.set(id, campaign);
        return campaign;
    };
    const currentRunning = userId => [...campaigns.values()].some(row => row.user_id === userId && row.status === 'running');

    db.getById = async (table, id, userId) => {
        const campaign = campaigns.get(Number(id));
        return table === 'campaigns' && campaign?.user_id === userId ? { ...campaign } : null;
    };
    db.select = async (table, _columns, where, params, _order, limit = 1000, offset = 0) => {
        if (table === 'campaigns') {
            const rows = [...campaigns.values()].filter(row => {
                if (where.includes('status = ?')) return row.user_id === params[0] && row.status === params[1];
                if (where.includes('status IN')) return ['running', 'paused', 'queued'].includes(row.status);
                return false;
            }).sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0));
            return rows.slice(offset, offset + limit).map(row => ({ ...row }));
        }
        return [];
    };
    db.update = async (table, data, _where, params) => {
        if (table === 'campaigns') {
            const row = campaigns.get(Number(params[0]));
            if (row?.user_id === params[1]) Object.assign(row, data);
            return row ? [row] : [];
        }
        return [];
    };
    db.count = async (table, _where, params) => {
        if (table === 'campaigns') return [...campaigns.values()].filter(row => row.user_id === params[0] && row.status === 'running').length;
        return 0;
    };
    db.recountCampaignCounters = async () => ({ ...counters });
    db.claimCampaignToRun = async (userId, campaignId, expectedStatus) => {
        claimCount++;
        if (currentRunning(userId)) return [];
        const target = campaignId === null
            ? [...campaigns.values()].filter(row => row.user_id === userId && row.status === 'queued').sort((a, b) => a.queue_position - b.queue_position)[0]
            : campaigns.get(Number(campaignId));
        if (!target || target.user_id !== userId || target.status !== expectedStatus) return [];
        target.status = 'running';
        target.queue_position = null;
        return [{ ...target }];
    };
    queue._ownerIsConnected = async () => true;
    queue._startProcessor = worker => {
        started.push(worker._campaignId);
        worker._processPromise = Promise.resolve();
    };
    queue.setIO({ to: room => ({ emit: (event, data) => events.push({ room, event, data }) }) });

    const finishCampaign = async (id, userId) => {
        const worker = Object.create(queue);
        Object.assign(worker, {
            _campaignId: id,
            _ownerUserId: userId,
            _provider: 'web',
            _running: true,
            _paused: false,
            _rateLimiter: null,
            _queues: queue._queues,
            _emit: queue._emit.bind(worker),
        });
        await worker._process();
    };

    try {
        queue._queues.clear();
        createCampaign(1, USER_A, 'running');
        createCampaign(2, USER_A, 'queued', 1);
        counters = { sent: 1, failed: 0, opt_outs: 0, skipped: 0, processed: 1 };
        await finishCampaign(1, USER_A);
        assert.equal(campaigns.get(1).status, 'completed');
        assert.equal(campaigns.get(2).status, 'running', 'a completed campaign hands off to the next queued campaign');
        assert.deepEqual(started.splice(0), [2]);

        queue._queues.clear();
        campaigns.get(2).status = 'completed';
        createCampaign(3, USER_A, 'running');
        createCampaign(4, USER_A, 'queued', 1);
        counters = { sent: 1, failed: 1, opt_outs: 0, skipped: 0, processed: 2 };
        await finishCampaign(3, USER_A);
        assert.equal(campaigns.get(3).status, 'completed_with_errors');
        assert.equal(campaigns.get(4).status, 'running', 'completed_with_errors also hands off');
        assert.deepEqual(started.splice(0), [4]);

        queue._queues.clear();
        campaigns.get(4).status = 'completed';
        createCampaign(5, USER_A, 'running');
        createCampaign(6, USER_A, 'queued', 1);
        counters = { sent: 0, failed: 1, opt_outs: 0, skipped: 0, processed: 1 };
        await finishCampaign(5, USER_A);
        assert.equal(campaigns.get(5).status, 'failed');
        assert.equal(campaigns.get(6).status, 'queued', 'failed campaigns do not advance the queue');
        assert.deepEqual(started.splice(0), []);

        queue._queues.clear();
        campaigns.get(6).status = 'failed';
        createCampaign(40, USER_A, 'running');
        createCampaign(41, USER_A, 'queued', 1);
        const pausedWorker = Object.create(queue);
        Object.assign(pausedWorker, { _campaignId: 40, _ownerUserId: USER_A, _running: true, _paused: false });
        queue._queues.set(USER_A, pausedWorker);
        await queue.pause(USER_A);
        assert.equal(campaigns.get(41).status, 'queued', 'pausing does not advance the queue');
        assert.deepEqual(started.splice(0), []);
        pausedWorker._paused = false;
        await queue.stop(USER_A);
        assert.equal(campaigns.get(40).status, 'stopped');
        assert.equal(campaigns.get(41).status, 'queued', 'stopping does not advance the queue');
        assert.deepEqual(started.splice(0), []);
        campaigns.get(41).status = 'failed';

        createCampaign(7, USER_A, 'queued', 1);
        queue._ownerIsConnected = async () => false;
        await queue._startNextQueuedCampaign(USER_A);
        assert.equal(campaigns.get(7).status, 'paused');
        assert.equal(campaigns.get(7).pause_reason, 'whatsapp_disconnected');
        assert.ok(events.some(event => event.event === 'campaign:paused' && event.data.reason === 'whatsapp_disconnected'));

        queue._queues.clear();
        campaigns.get(7).status = 'queued';
        campaigns.get(7).pause_reason = null;
        queue._ownerIsConnected = async () => true;
        const recovered = await queue.resumeInterrupted(null);
        assert.equal(recovered.ok, true);
        assert.equal(campaigns.get(7).status, 'running', 'restart recovery starts the first queued campaign');
        assert.deepEqual(started.splice(0), [7]);

        queue._queues.clear();
        campaigns.get(7).status = 'completed';
        createCampaign(8, USER_A, 'queued', 1).media_path = 'shared-media';
        campaignMediaStorage.downloadCampaignMedia = async () => { throw new Error('Attachment object not found'); };
        await queue._startNextQueuedCampaign(USER_A);
        assert.equal(campaigns.get(8).status, 'paused', 'an invalid queued attachment pauses before a worker starts');
        assert.equal(campaigns.get(8).pause_reason, 'media_load_failed');
        campaignMediaStorage.downloadCampaignMedia = original.downloadCampaignMedia;

        queue._queues.clear();
        campaigns.get(8).status = 'failed';
        createCampaign(20, USER_A, 'queued', 1);
        createCampaign(21, USER_B, 'queued', 1);
        await Promise.all([queue._startNextQueuedCampaign(USER_A), queue._startNextQueuedCampaign(USER_B)]);
        assert.equal(campaigns.get(20).status, 'running');
        assert.equal(campaigns.get(21).status, 'running');
        assert.deepEqual(started.splice(0).sort(), [20, 21], 'different owners have independent queues');

        queue._queues.clear();
        campaigns.get(20).status = 'completed';
        campaigns.get(21).status = 'completed';
        createCampaign(30, USER_A, 'queued', 1);
        const claimStart = claimCount;
        await Promise.all([queue._startNextQueuedCampaign(USER_A), queue._startNextQueuedCampaign(USER_A)]);
        assert.equal(campaigns.get(30).status, 'running');
        assert.deepEqual(started.splice(0), [30], 'concurrent hand-off starts one campaign exactly once');
        assert.equal(claimCount - claimStart, 2, 'both claim attempts are serialized by the mocked atomic RPC');
        console.log('Campaign queue handoff/recovery smoke test passed');
    } finally {
        for (const worker of queue._queues.values()) worker._running = false;
        queue._queues.clear();
        Object.assign(db, original);
        queue._startProcessor = original.startProcessor;
        queue._ownerIsConnected = original.ownerIsConnected;
        campaignMediaStorage.downloadCampaignMedia = original.downloadCampaignMedia;
        queue._io = original.io;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
