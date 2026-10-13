const assert = require('node:assert/strict');
const db = require('../../database/db');
const campaignService = require('../campaignService');
const messageQueue = require('../messageQueue');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CAMPAIGN_ID = 42;

async function main() {
    const originals = {
        getById: db.getById,
        count: db.count,
        update: db.update,
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
        status: 'completed',
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
    db.count = async (table, where, params) => {
        assert.equal(table, 'campaign_contacts');
        assert.equal(where, 'campaign_id = ? AND user_id = ? AND status = ?');
        assert.deepEqual(params, [CAMPAIGN_ID, USER_ID, 'failed']);
        return 2;
    };
    db.update = async (table, data, where, params) => {
        updates.push({ table, data, where, params });
        if (table === 'campaign_contacts') return [{ id: 5 }, { id: 6 }];
        Object.assign(campaign, data);
        return [];
    };
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
        assert.deepEqual(result, { requeued: 2 });
        assert.deepEqual(updates[0], {
            table: 'campaign_contacts',
            data: { status: 'pending', attempts: 0, last_error: null, retry_at: null },
            where: 'campaign_id = ? AND user_id = ? AND status = ?',
            params: [CAMPAIGN_ID, USER_ID, 'failed'],
        });
        assert.equal(updates[1].table, 'campaigns');
        assert.equal(updates[1].data.status, 'stopped');
        assert.equal(updates[1].data.processed, 1);
        assert.equal(updates[1].data.failed, 0);
        assert.equal(updates[1].data.completed_at, null);
        assert.equal(ioPassed, io);
        assert.deepEqual(started, {
            id: CAMPAIGN_ID,
            settings: { retryCount: 2 },
            userId: USER_ID,
        });
        console.log('Campaign retry-failed smoke test passed');
    } finally {
        Object.assign(db, { getById: originals.getById, count: originals.count, update: originals.update });
        Object.assign(messageQueue, {
            getCurrentCampaignId: originals.getCurrentCampaignId,
            setIO: originals.setIO,
            start: originals.start,
        });
        campaignService._assertOwnerConnected = originals.assertOwnerConnected;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
