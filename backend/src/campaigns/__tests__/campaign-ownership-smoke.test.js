const assert = require('assert');
const express = require('express');
const db = require('../../database/db');
const messageQueue = require('../messageQueue');
const campaignService = require('../campaignService');
const campaignRoutes = require('../../routes/campaigns');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const campaigns = new Map([[101, { id: 101, user_id: USER_A, name: 'A campaign', status: 'draft', provider: 'web', settings: '{}' }]]);

async function main() {
    const originals = { getById: db.getById, update: db.update, select: db.select, count: db.count, claimCampaignToRun: db.claimCampaignToRun };
    let finishContactSelect;
    db.getById = async (table, id, userId) => table === 'campaigns' && campaigns.get(Number(id))?.user_id === userId ? { ...campaigns.get(Number(id)) } : null;
    db.update = async () => [];
    db.claimCampaignToRun = async (_userId, id) => [{ id }];
    db.select = async (table) => table === 'campaign_contacts'
        ? new Promise(resolve => { finishContactSelect = resolve; })
        : [];
    db.count = async table => table === 'campaign_contacts' ? 1 : 0;
    campaignService._assertOwnerConnected = async () => {};
    await campaignService.start(101, null, USER_A);
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(messageQueue.isRunning(USER_A), true, 'owner A queue is running');
    await assert.rejects(async () => campaignService.pause(101, USER_B), /not currently running/i);
    messageQueue.pause(USER_B);
    assert.strictEqual(messageQueue.isRunning(USER_A), true, 'direct B queue control cannot pause A worker');
    await assert.rejects(campaignService.stop(101, USER_B), /Campaign not found/i);
    await assert.rejects(campaignService.delete(101, USER_B), /Campaign not found/i);
    assert.strictEqual(messageQueue.isRunning(USER_A), true, 'B actions leave A queue running');
    assert.strictEqual(messageQueue.getCurrentCampaignId(USER_A), 101);

    const app = express();
    app.use((req, _res, next) => { req.user = { id: USER_B }; next(); });
    app.use('/api/campaigns', campaignRoutes);
    const server = app.listen(0);
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/campaigns/queue-status`);
        assert.strictEqual(response.status, 200);
        const status = await response.json();
        assert.strictEqual(status.running, false);
        assert.strictEqual(status.paused, false);
        assert.strictEqual(status.currentCampaignId, null);
    } finally {
        await campaignService.stop(101, USER_A);
        finishContactSelect?.([]);
        await new Promise(resolve => server.close(resolve));
        Object.assign(db, originals);
    }
    console.log('Campaign ownership smoke test passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
