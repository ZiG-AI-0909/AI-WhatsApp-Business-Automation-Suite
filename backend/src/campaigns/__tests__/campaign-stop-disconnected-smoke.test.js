// =============================================================
// Smoke test — a campaign paused because WhatsApp disconnected can be
// stopped while WhatsApp is still disconnected, and reconnecting does not
// restart it. Stubs the db layer; never boots server.js.
// =============================================================
const assert = require('node:assert/strict');
const db = require('../../database/db');
const queue = require('../messageQueue');
const campaignService = require('../campaignService');

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function main() {
    const original = { getById: db.getById, update: db.update, select: db.select, recount: db.recountCampaignCounters };
    const campaign = { id: 7, user_id: USER_ID, status: 'paused', pause_reason: 'whatsapp_disconnected', provider: 'web', settings: '{}' };
    const updates = [];
    db.getById = async (table, id) => (table === 'campaigns' && Number(id) === campaign.id ? { ...campaign } : null);
    db.update = async (table, data, where, params) => {
        updates.push({ table, data, where, params });
        if (table === 'campaigns') Object.assign(campaign, data);
        return [];
    };
    db.recountCampaignCounters = async () => ({ sent: 3, failed: 0, processed: 3 });
    db.select = async (table, columns, where, params) => (table === 'campaigns' && params?.[1] === 'paused' && campaign.status === 'paused' ? [{ ...campaign }] : []);

    try {
        queue._queues.clear(); // the disconnect pause unloaded the worker

        await campaignService.stop(7, USER_ID);
        const skipped = updates.find((u) => u.table === 'campaign_contacts');
        assert.equal(skipped.data.status, 'skipped', 'remaining contacts are skipped');
        assert.match(skipped.where, /status IN \('pending', 'processing'\)/);
        assert.equal(campaign.status, 'stopped', 'campaign stopped without WhatsApp being connected');
        assert.ok(campaign.completed_at instanceof Date);

        // WhatsApp reconnects: only paused-by-disconnect campaigns resume; this one stays stopped.
        const resumed = await queue.resumeDisconnectedCampaigns(USER_ID);
        assert.equal(resumed, null);
        assert.equal(campaign.status, 'stopped');

        // Stopping again is harmless.
        const before = updates.length;
        await campaignService.stop(7, USER_ID);
        assert.equal(updates.length, before, 'an already-stopped campaign is left alone');

        console.log('ok   paused-by-disconnect campaign can be stopped while disconnected; reconnect does not restart it');
    } finally {
        Object.assign(db, { getById: original.getById, update: original.update, select: original.select, recountCampaignCounters: original.recount });
    }
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
