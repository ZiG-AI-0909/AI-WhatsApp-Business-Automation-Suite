const assert = require('node:assert/strict');
const db = require('../../database/db');
const campaignService = require('../campaignService');
const messageQueue = require('../messageQueue');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CAMPAIGN_ID = 42;
const FAILED_TOTAL = 1200;

async function main() {
    const originals = {
        getById: db.getById,
        select: db.select,
        count: db.count,
        update: db.update,
        recountCampaignCounters: db.recountCampaignCounters,
        getCurrentCampaignId: messageQueue.getCurrentCampaignId,
        setIO: messageQueue.setIO,
        start: messageQueue.start,
        assertOwnerConnected: campaignService._assertOwnerConnected,
    };
    const updates = [];
    let started;
    let ioPassed;
    const campaign = {
        id: CAMPAIGN_ID,
        user_id: USER_ID,
        status: 'completed_with_errors',
        provider: 'web',
        settings: '{"retryCount":2}',
        processed: 3,
        sent: 1,
        failed: 2,
    };

    db.getById = async (table, id, userId) => {
        assert.equal(table, 'campaigns');
        assert.equal(Number(id), CAMPAIGN_ID);
        assert.equal(userId, USER_ID);
        return { ...campaign };
    };
    db.select = async (table, _columns, where, params, _order, limit, offset) => {
        assert.equal(table, 'campaign_contacts');
        assert.deepEqual(params, [CAMPAIGN_ID, USER_ID, 'failed']);
        assert.equal(where, 'campaign_id = ? AND user_id = ? AND status = ?');
        const ids = Array.from({ length: FAILED_TOTAL }, (_, id) => ({ id: id + 1 }));
        return ids.slice(offset, offset + limit);
    };
    db.update = async (table, data, where, params) => {
        updates.push({ table, data, where, params });
        if (table === 'campaign_contacts') return params[0].map(id => ({ id }));
        Object.assign(campaign, data);
        return [];
    };
    db.recountCampaignCounters = async () => ({ processed: 1, sent: 1, failed: 0, opt_outs: 0, skipped: 0 });
    messageQueue.getCurrentCampaignId = () => null;
    messageQueue.setIO = (io) => { ioPassed = io; };
    messageQueue.start = async (id, settings, userId) => { started = { id, settings, userId }; };
    campaignService._assertOwnerConnected = async (userId, provider) => {
        assert.equal(userId, USER_ID);
        assert.equal(provider, 'web');
    };

    try {
        const io = { marker: true };
        const result = await campaignService.retryFailed(CAMPAIGN_ID, io, USER_ID);
        assert.deepEqual(result, { requeued: FAILED_TOTAL });
        assert.deepEqual(updates[0], {
            table: 'campaign_contacts',
            data: { status: 'pending', attempts: 0, last_error: null, retry_at: null },
            where: 'id IN (?) AND campaign_id = ? AND user_id = ? AND status = ?',
            params: [Array.from({ length: 500 }, (_, id) => id + 1), CAMPAIGN_ID, USER_ID, 'failed'],
        });
        const contactUpdates = updates.filter(update => update.table === 'campaign_contacts');
        assert.deepEqual(contactUpdates.map(update => update.params[0].length), [500, 500, 200]);
        assert.equal(updates[3].table, 'campaigns');
        assert.equal(updates[3].data.status, 'stopped');
        assert.equal(updates[3].data.processed, 1);
        assert.equal(updates[3].data.failed, 0);
        assert.equal(updates[3].data.completed_at, null);
        assert.equal(ioPassed, io);
        assert.deepEqual(started, {
            id: CAMPAIGN_ID,
            settings: { retryCount: 2 },
            userId: USER_ID,
        });
        console.log('Campaign retry-failed smoke test passed');
    } finally {
        Object.assign(db, { getById: originals.getById, select: originals.select, count: originals.count, update: originals.update, recountCampaignCounters: originals.recountCampaignCounters });
        Object.assign(messageQueue, {
            getCurrentCampaignId: originals.getCurrentCampaignId,
            setIO: originals.setIO,
            start: originals.start,
        });
        campaignService._assertOwnerConnected = originals.assertOwnerConnected;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
