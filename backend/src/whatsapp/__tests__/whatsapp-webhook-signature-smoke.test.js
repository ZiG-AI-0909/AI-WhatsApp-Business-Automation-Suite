const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const db = require('../../database/db');
const businessApiProvider = require('../businessApiProvider');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SECRET_A = 'user-A-secret-for-webhook-test';
const SECRET_B = 'user-B-secret-for-webhook-test';
const PHONE_ID_B = 'phone-number-B';
const appSettings = [
    { user_id: USER_A, key: 'WABA_PHONE_NUMBER_ID', value: 'phone-number-A' },
    { user_id: USER_A, key: 'APP_SECRET', value: SECRET_A },
    { user_id: USER_B, key: 'WABA_PHONE_NUMBER_ID', value: PHONE_ID_B },
    { user_id: USER_B, key: 'APP_SECRET', value: SECRET_B },
];

function sign(body, secret) {
    return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function main() {
    const originalSelect = db.select;
    const originalIsAvailable = db.isAvailable;
    const incomingPath = require.resolve('../../conversations/incomingMessageService');
    const oldIncoming = require.cache[incomingPath];
    const oldWabaSecret = process.env.WABA_APP_SECRET;
    const oldMetaSecret = process.env.META_APP_SECRET;
    process.env.WABA_APP_SECRET = SECRET_A;
    let processed = [];
    db.isAvailable = () => true;
    db.select = async (table, _columns, where, params) => {
        if (table !== 'app_settings') return [];
        if (where.includes('user_id = ?')) return appSettings.filter(row => row.user_id === params[0] && ['APP_SECRET', 'WABA_CONFIG', 'WHATSAPP_BUSINESS_API', 'BUSINESS_API_CONFIG'].includes(row.key));
        return appSettings.filter(row => ['WABA_CONFIG', 'WHATSAPP_BUSINESS_API', 'BUSINESS_API_CONFIG', 'WABA_PHONE_NUMBER_ID', 'PHONE_NUMBER_ID', 'WABA_ACCESS_TOKEN', 'WABA_WEBHOOK_VERIFY_TOKEN'].includes(row.key));
    };
    require.cache[incomingPath] = {
        id: incomingPath,
        filename: incomingPath,
        loaded: true,
        exports: { process: async (message, userId) => { processed.push({ message, userId }); } },
    };

    const routerPath = require.resolve('../../routes/whatsappWebhook');
    delete require.cache[routerPath];
    const router = require('../../routes/whatsappWebhook');
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use('/webhook', router);
    const server = app.listen(0);
    const payload = phoneNumberId => JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: {
            metadata: { phone_number_id: phoneNumberId },
            messages: [{ id: 'msg-1', from: '919999000000', type: 'text', text: { body: 'Hello' } }],
        } }] }],
    });
    async function post(body, secret) {
        return fetch(`http://127.0.0.1:${server.address().port}/webhook/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body, secret) },
            body,
        });
    }
    async function postRaw(body, signature = '') {
        return fetch(`http://127.0.0.1:${server.address().port}/webhook/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
            body,
        });
    }
    const statusPayload = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: {
            metadata: { phone_number_id: PHONE_ID_B },
            statuses: [{ id: 'wamid.status-1', status: 'delivered' }],
        } }] }],
    });

    try {
        businessApiProvider.userConfigs.clear();
        assert.strictEqual(await businessApiProvider.findUserIdByPhoneNumberId(PHONE_ID_B), USER_B, 'owner lookup reloads from app_settings after clearing memory');
        businessApiProvider.userConfigs.clear();

        assert.strictEqual((await post(statusPayload, SECRET_A)).status, 401, 'status-only events also require the owning user signature');
        assert.strictEqual((await post(statusPayload, SECRET_B)).status, 200, 'valid status-only events are acknowledged');
        assert.strictEqual(processed.length, 0, 'status-only events do not enter incoming message processing');

        const addressedToB = payload(PHONE_ID_B);
        const wrongOwnerSignature = await post(addressedToB, SECRET_A);
        assert.strictEqual(wrongOwnerSignature.status, 401, 'A signature cannot authenticate B phone_number_id');
        assert.strictEqual(processed.length, 0);

        const valid = await post(addressedToB, SECRET_B);
        assert.strictEqual(valid.status, 200, 'B signature is accepted for B phone_number_id');
        assert.strictEqual(processed.length, 1);
        assert.strictEqual(processed[0].userId, USER_B);

        assert.strictEqual(processed.length, 1, 'status-only events do not enter incoming message processing');

        assert.strictEqual((await postRaw('{invalid-json', SECRET_B)).status, 400, 'malformed JSON is rejected');

        appSettings.length = 0;
        businessApiProvider.userConfigs.clear();
        delete process.env.WABA_APP_SECRET;
        delete process.env.META_APP_SECRET;
        assert.strictEqual((await post(statusPayload, SECRET_B)).status, 403, 'requests are rejected when no user or environment secret exists');
        console.log('WhatsApp webhook signature smoke test passed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.select = originalSelect;
        db.isAvailable = originalIsAvailable;
        if (oldWabaSecret === undefined) delete process.env.WABA_APP_SECRET;
        else process.env.WABA_APP_SECRET = oldWabaSecret;
        if (oldMetaSecret === undefined) delete process.env.META_APP_SECRET;
        else process.env.META_APP_SECRET = oldMetaSecret;
        appSettings.splice(0, appSettings.length,
            { user_id: USER_A, key: 'WABA_PHONE_NUMBER_ID', value: 'phone-number-A' },
            { user_id: USER_A, key: 'APP_SECRET', value: SECRET_A },
            { user_id: USER_B, key: 'WABA_PHONE_NUMBER_ID', value: PHONE_ID_B },
            { user_id: USER_B, key: 'APP_SECRET', value: SECRET_B });
        if (oldIncoming) require.cache[incomingPath] = oldIncoming;
        else delete require.cache[incomingPath];
        delete require.cache[routerPath];
        businessApiProvider.userConfigs.clear();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
