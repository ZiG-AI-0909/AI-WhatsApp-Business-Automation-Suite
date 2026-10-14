const assert = require('node:assert/strict');
const db = require('../../database/db');
const queue = require('../messageQueue');
const campaignMediaStorage = require('../campaignMediaStorage');
const sessionManager = require('../../whatsapp/sessionManager');
const campaignRoutes = require('../../routes/campaigns');

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
    const originalDownload = campaignMediaStorage.downloadCampaignMedia;
    let contactReads = 0;
    db.getById = async () => ({
        id: 42,
        status: 'draft',
        name: 'media campaign',
        provider: 'business',
        media_path: 'https://storage.example.test/storage/v1/object/public/campaign-media/missing.png',
        media_bucket: 'campaign-media',
        media_object_path: 'missing.png',
    });
    campaignMediaStorage.downloadCampaignMedia = async () => {
        throw new Error('Attachment could not be loaded from Supabase Storage (campaign-media/missing.png): Object not found');
    };
    const originalSelect = db.select;
    db.select = async () => { contactReads++; return []; };
    try {
        queue._queues.delete(USER_ID);
        await assert.rejects(
            queue.start(42, {}, USER_ID),
            /campaign-media\/missing\.png.*Object not found/
        );
        assert.equal(queue._worker(USER_ID), null);
        assert.equal(contactReads, 0, 'no contacts are read or consumed when the attachment cannot load');
    } finally {
        db.getById = originalGetById;
        db.select = originalSelect;
        campaignMediaStorage.downloadCampaignMedia = originalDownload;
        queue._queues.delete(USER_ID);
    }
}

async function testMediaBufferIsDownloadedOnceAndReused() {
    const originalDownload = campaignMediaStorage.downloadCampaignMedia;
    const originalSelect = db.select;
    const originalUpdate = db.update;
    const originalCount = db.count;
    const originalRecount = db.recountCampaignCounters;
    const originalFindByPhone = require('../../contacts/contactService').findByPhone;
    const contactService = require('../../contacts/contactService');
    const buffer = Buffer.from('media bytes');
    let downloadCount = 0;
    let nextContact = 0;
    const mediaBuffers = [];
    campaignMediaStorage.downloadCampaignMedia = async campaign => {
        downloadCount++;
        assert.equal(campaign.media_bucket, 'campaign-media');
        assert.equal(campaign.media_object_path, 'test/image.png');
        return { buffer, bucket: campaign.media_bucket, objectPath: campaign.media_object_path };
    };
    db.select = async () => {
        if (nextContact >= 2) return [];
        nextContact++;
        return [{
            id: nextContact,
            campaign_id: 43,
            contact_id: nextContact,
            rendered_message: `Message ${nextContact}`,
            attempts: 0,
            contacts: { phone: `1555000000${nextContact}` },
            campaigns: {
                media_path: 'https://storage.example.test/storage/v1/object/public/campaign-media/test/image.png',
                media_bucket: 'campaign-media',
                media_object_path: 'test/image.png',
                media_type: 'image',
                media_filename: 'image.png',
                media_mimetype: 'image/png',
            },
        }];
    };
    db.update = async () => [];
    db.count = async () => 0;
    db.recountCampaignCounters = async () => ({ processed: 2, sent: 2, failed: 0, opt_outs: 0 });
    contactService.findByPhone = async () => ({ marketing_opt_in: true });
    const worker = Object.create(queue);
    Object.assign(worker, {
        _campaignId: 43,
        _ownerUserId: USER_ID,
        _provider: 'web',
        _running: true,
        _paused: false,
        _rateLimiter: null,
        _mediaBuffer: null,
        _queues: new Map(),
        _emit: () => {},
        _emitProgress: () => {},
        _getSender: async () => async (_phone, _body, media) => {
            mediaBuffers.push(media.buffer);
            return { id: 'sent' };
        },
    });
    try {
        await worker._loadCampaignMedia({
            media_path: 'https://storage.example.test/storage/v1/object/public/campaign-media/test/image.png',
            media_bucket: 'campaign-media',
            media_object_path: 'test/image.png',
        });
        await worker._process();
        assert.equal(downloadCount, 1);
        assert.equal(mediaBuffers.length, 2);
        assert.strictEqual(mediaBuffers[0], buffer);
        assert.strictEqual(mediaBuffers[1], buffer);
    } finally {
        campaignMediaStorage.downloadCampaignMedia = originalDownload;
        db.select = originalSelect;
        db.update = originalUpdate;
        db.count = originalCount;
        db.recountCampaignCounters = originalRecount;
        contactService.findByPhone = originalFindByPhone;
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

async function testProviderRestrictionPausesImmediately() {
    const updates = [];
    const events = [];
    const worker = createFailureWorker(updates, events);
    const paused = await worker._handleSendFailure(
        Object.assign(new Error('Too many requests'), {
            response: { status: 429, data: { error: { code: 130429, message: 'Rate limit hit' } } },
        }),
        { id: 12, media_path: null },
        0,
        true,
        42,
        USER_ID
    );

    assert.equal(paused, true);
    assert.equal(worker._paused, true);
    assert.equal(updates.find(update => update.table === 'campaigns').data.pause_reason, 'provider_restriction');
    assert.equal(events[0].event, 'campaign:paused');
}

async function testMissingOrOptedOutContactIsNeverSent() {
    const originalSelect = db.select;
    const originalCount = db.count;
    const contactService = require('../../contacts/contactService');
    const originalFindByPhone = contactService.findByPhone;

    try {
        for (const contact of [null, { marketing_opt_in: 0 }]) {
            let pendingRead = false;
            let senderLookups = 0;
            const updates = [];
            db.select = async () => {
                if (pendingRead) return [];
                pendingRead = true;
                return [{
                    id: 10,
                    campaign_id: 42,
                    contact_id: 99,
                    rendered_message: 'Hello',
                    status: 'pending',
                    attempts: 0,
                    contacts: { phone: '15551234567' },
                    campaigns: {},
                }];
            };
            db.count = async () => 0;
            contactService.findByPhone = async () => contact;
            const worker = Object.create(queue);
            Object.assign(worker, {
                _campaignId: 42,
                _ownerUserId: USER_ID,
                _running: true,
                _paused: false,
                _rateLimiter: null,
                _emit: () => {},
                _emitProgress: () => {},
                _update: async (_worker, table, data) => updates.push({ table, data }),
                _recountCampaign: async () => {},
                _getSender: async () => { senderLookups++; return async () => {}; },
            });

            await worker._process();
            assert.equal(senderLookups, 0, 'no sender is resolved for a missing or opted-out contact');
            assert.ok(updates.some(update => update.table === 'campaign_contacts' && update.data.status === 'opted_out'));
        }
    } finally {
        db.select = originalSelect;
        db.count = originalCount;
        contactService.findByPhone = originalFindByPhone;
    }
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

async function testBaileysUsesImageAndDocumentBuffers() {
    const originalSession = sessionManager.sessions.get(USER_ID);
    const originalTouch = sessionManager._touchActivity;
    const sent = [];
    const buffer = Buffer.from('file bytes');
    sessionManager.sessions.set(USER_ID, {
        status: 'connected',
        socket: {
            user: { id: '15551234567:4@s.whatsapp.net' },
            sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { key: { id: 'ok' } }; },
        },
    });
    sessionManager._touchActivity = () => {};
    try {
        assert.equal(sessionManager.getOwnPhoneNumber(USER_ID), '15551234567');
        await sessionManager.sendMessage(USER_ID, '', 'image caption', '15551234567@s.whatsapp.net', {
            buffer, type: 'image', mimetype: 'image/png',
        });
        await sessionManager.sendMessage(USER_ID, '', 'document caption', '15551234567@s.whatsapp.net', {
            buffer, type: 'document', filename: 'file.pdf', mimetype: 'application/pdf',
        });
        assert.strictEqual(sent[0].payload.image, buffer);
        assert.equal(sent[0].payload.caption, 'image caption');
        assert.strictEqual(sent[1].payload.document, buffer);
        assert.equal(sent[1].payload.fileName, 'file.pdf');
        assert.equal(sent[1].payload.mimetype, 'application/pdf');
    } finally {
        sessionManager._touchActivity = originalTouch;
        if (originalSession) sessionManager.sessions.set(USER_ID, originalSession);
        else sessionManager.sessions.delete(USER_ID);
    }
}

function testCampaignMediaNamesAndSupabaseUrls() {
    assert.equal(campaignRoutes.sanitizeCampaignMediaFilename('Dealer List & Promo (Final).PDF'), 'dealer-list-promo-final.pdf');
    assert.deepEqual(campaignMediaStorage.resolveCampaignMediaLocation({
        media_path: 'https://project.supabase.co/storage/v1/object/public/campaign-media/media/my%20image%20%26%20promo.png?token=private',
    }), {
        bucket: 'campaign-media',
        objectPath: 'media/my image & promo.png',
    });
}

async function main() {
    const originalUpdate = db.update;
    const originalRecount = db.recountCampaignCounters;
    db.update = async () => [];
    db.recountCampaignCounters = async () => ({ processed: 0, sent: 0, failed: 0, opt_outs: 0 });
    try {
        await testMediaMustLoadBeforeStart();
        await testMediaBufferIsDownloadedOnceAndReused();
        await testRepeatedErrorsPauseAndRestoreContacts();
        await testNotRegisteredDoesNotTripBreaker();
        await testProviderRestrictionPausesImmediately();
        await testMissingOrOptedOutContactIsNeverSent();
        testSendErrorDetailsAreSanitized();
        await testBaileysUsesImageAndDocumentBuffers();
        testCampaignMediaNamesAndSupabaseUrls();
    } finally {
        db.update = originalUpdate;
        db.recountCampaignCounters = originalRecount;
    }
    console.log('Message queue systematic-failure smoke tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
