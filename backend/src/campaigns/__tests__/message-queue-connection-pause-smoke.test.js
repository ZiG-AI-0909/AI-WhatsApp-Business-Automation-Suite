const assert = require('node:assert/strict');
const db = require('../../database/db');
const contactService = require('../../contacts/contactService');
const queue = require('../messageQueue');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function main() {
    const original = {
        select: db.select,
        update: db.update,
        count: db.count,
        findByPhone: contactService.findByPhone,
    };
    // No sends were interrupted before this run.
    db.count = async () => 0;
    const updates = [];
    const emitted = [];
    let selected = false;
    db.select = async () => {
        if (selected) return [];
        selected = true;
        return [{
            id: 12,
            campaign_id: 3,
            contact_id: 9,
            rendered_message: 'hello',
            status: 'pending',
            attempts: 0,
            contacts: { phone: '+15551234567' },
            campaigns: {},
        }];
    };
    db.update = async (table, data) => { updates.push({ table, data }); return []; };
    contactService.findByPhone = async () => ({ marketing_opt_in: 1 });

    try {
        queue._queues.clear();
        await queue._process.call(Object.assign(Object.create(queue), {
            _campaignId: 3,
            _ownerUserId: USER_ID,
            _provider: 'web',
            _running: true,
            _paused: false,
            _rateLimiter: null,
            _queues: queue._queues,
            _update: queue._update,
            _handleSendFailure: queue._handleSendFailure,
            _pauseCampaignForSendFailure: queue._pauseCampaignForSendFailure,
            _recountCampaign: async () => {},
            _getSender: async () => { throw new Error('Your WhatsApp session is not connected.'); },
            _emit: (event, payload) => emitted.push({ event, payload }),
            _emitProgress: () => {},
        }));

        const contactUpdate = updates.find(update => update.table === 'campaign_contacts' && update.data.attempts !== undefined);
        const campaignUpdate = updates.find(update => update.table === 'campaigns');
        assert.equal(contactUpdate.data.status, 'pending');
        assert.equal(contactUpdate.data.attempts, 0);
        assert.equal(campaignUpdate.data.status, 'paused');
        assert.equal(campaignUpdate.data.pause_reason, 'whatsapp_disconnected');
        assert.match(campaignUpdate.data.last_error, /not connected/i);
        assert.deepEqual(emitted[0], {
            event: 'campaign:paused',
            payload: { campaignId: 3, reason: 'whatsapp_disconnected', error: campaignUpdate.data.last_error },
        });
        assert.equal(queue.isRunning(USER_ID), false);
        console.log('Message queue connection-pause smoke test passed');
    } finally {
        queue._queues.clear();
        Object.assign(db, { select: original.select, update: original.update, count: original.count });
        contactService.findByPhone = original.findByPhone;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
