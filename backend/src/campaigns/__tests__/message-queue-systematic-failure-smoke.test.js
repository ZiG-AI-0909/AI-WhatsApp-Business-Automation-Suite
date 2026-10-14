const assert = require('node:assert/strict');
const db = require('../../database/db');
const queue = require('../messageQueue');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function createFailureWorker(updates, events, threshold = 5) {
    const worker = Object.create(queue);
    Object.assign(worker, {
        _campaignId: 42,
        _ownerUserId: USER_ID,
        _provider: 'business',
        _running: true,
        _paused: false,
        _rateLimiter: { settings: { retryCount: 2, retryDelay: 1000, circuitBreakerThreshold: threshold } },
        _consecutiveSendFailures: 0,
        _lastSendFailure: null,
        _consecutiveFailureContacts: [],
        _emit: (event, payload) => events.push({ event, payload }),
        _recountCampaign: async () => {},
    });
    worker._update = async (_worker, table, data, _where, params) => {
        updates.push({ table, data, params });
    };
    return worker;
}

async function testMediaMustLoadBeforeStart() {
    const originalGetById = db.getById;
    const originalFetch = global.fetch;
    db.getById = async () => ({
        id: 42,
        name: 'media campaign',
        provider: 'business',
        media_path: 'https://storage.example.test/campaign.png?token=secret',
    });
    global.fetch = async () => ({
        ok: false,
        status: 400,
        body: { cancel: async () => {} },
    });
    try {
        queue._queues.delete(USER_ID);
        await assert.rejects(
            queue.start(42, {}, USER_ID),
            /Attachment could not be loaded \(HTTP 400\) - re-upload the file/
        );
        assert.equal(queue._worker(USER_ID), null);
    } finally {
        db.getById = originalGetById;
        global.fetch = originalFetch;
        queue._queues.delete(USER_ID);
    }
}

async function testRepeatedErrorsPauseAndRestoreContacts() {
    const updates = [];
    const events = [];
    const worker = createFailureWorker(updates, events);
    for (let id = 1; id <= 5; id++) {
        await worker._handleSendFailure(
            Object.assign(new Error('HTTP 400: request failed'), { response: { status: 400 } }),
            { id, media_path: null },
            0,
            true,
            42,
            USER_ID
        );
    }
    const contactStates = updates.filter(update => update.table === 'campaign_contacts');
    assert.equal(contactStates.length, 9);
    const finalStates = new Map();
    for (const update of contactStates) finalStates.set(update.params[0], update.data);
    assert.equal(finalStates.size, 5);
    for (const state of finalStates.values()) {
        assert.equal(state.status, 'pending');
        assert.equal(state.attempts, 0);
    }
    const pause = updates.find(update => update.table === 'campaigns');
    assert.equal(pause.data.status, 'paused');
    assert.equal(pause.data.pause_reason, 'repeated_send_failures');
    assert.match(pause.data.last_error, /HTTP 400/);
    assert.equal(events[0].event, 'campaign:paused');
    assert.equal(events[0].payload.reason, 'repeated_send_failures');
}

async function testNotRegisteredDoesNotTripBreaker() {
    const updates = [];
    const events = [];
    const worker = createFailureWorker(updates, events);
    for (let id = 1; id <= 5; id++) {
        await worker._handleSendFailure(
            Object.assign(new Error('Request failed'), {
                response: { status: 400, data: { message: 'WhatsApp number is not registered' } },
            }),
            { id, media_path: null },
            0,
            true,
            42,
            USER_ID
        );
    }
    assert.equal(updates.some(update => update.table === 'campaigns' && update.data.pause_reason), false);
    assert.equal(events.some(event => event.event === 'campaign:paused'), false);
    assert.equal(updates.filter(update => update.table === 'campaign_contacts' && update.data.status === 'failed').length, 5);
}

function testSendErrorDetailsAreSanitized() {
    const description = queue.describeSendError({
        message: 'Request failed for https://graph.facebook.com/v23.0/123/media?access_token=secret',
        config: { url: 'https://graph.facebook.com/v23.0/123/media?access_token=secret' },
        response: {
            status: 400,
            data: { message: 'invalid request', access_token: 'response-secret' },
        },
    });
    assert.match(description, /HTTP 400/);
    assert.match(description, /graph\.facebook\.com\/v23\.0\/123\/media/);
    assert.doesNotMatch(description, /secret/);
    assert.doesNotMatch(description, /access_token=/);
}

async function main() {
    const originalUpdate = db.update;
    const originalRecount = db.recountCampaignCounters;
    db.update = async () => [];
    db.recountCampaignCounters = async () => ({ processed: 0, sent: 0, failed: 0, opt_outs: 0 });
    try {
        await testMediaMustLoadBeforeStart();
        await testRepeatedErrorsPauseAndRestoreContacts();
        await testNotRegisteredDoesNotTripBreaker();
        testSendErrorDetailsAreSanitized();
    } finally {
        db.update = originalUpdate;
        db.recountCampaignCounters = originalRecount;
    }
    console.log('Message queue systematic-failure smoke tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
