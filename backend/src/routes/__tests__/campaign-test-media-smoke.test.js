const assert = require('node:assert/strict');
const express = require('express');
const db = require('../../database/db');
const campaignService = require('../../campaigns/campaignService');
const campaignMediaStorage = require('../../campaigns/campaignMediaStorage');
const sessionManager = require('../../whatsapp/sessionManager');
const campaignsRouter = require('../campaigns');

const campaign = {
    id: 1,
    media_path: 'media/test.jpg',
    provider: 'web',
    template_message: 'Hello {{name}}',
    media_type: 'image',
    media_filename: 'test.jpg',
    media_mimetype: 'image/jpeg',
};
let contactRows = [];
let sent;

campaignService.get = async () => campaign;
db.select = async (table) => {
    assert.equal(table, 'campaign_contacts');
    return contactRows;
};
campaignMediaStorage.downloadCampaignMedia = async () => ({ buffer: Buffer.from('test-media') });
sessionManager.getStatus = () => 'connected';
sessionManager.getOwnPhoneNumber = () => '919876543210';
sessionManager.sendMessage = async (...args) => { sent = args; };

async function main() {
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'user-1' }; next(); });
    app.use('/campaigns', campaignsRouter);
    const server = app.listen(0);

    try {
        const call = async () => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/campaigns/1/test-media`, { method: 'POST' });
            return { status: response.status, data: await response.json() };
        };

        const fallback = await call();
        assert.equal(fallback.status, 200);
        assert.equal(sent[2], campaign.template_message, 'uses the saved template when no rendered contact message exists');

        contactRows = [{ rendered_message: 'Hello Ada' }];
        const rendered = await call();
        assert.equal(rendered.status, 200);
        assert.equal(sent[2], 'Hello Ada', 'prefers the rendered recipient message when available');

        contactRows = [];
        campaign.template_message = '  ';
        const missing = await call();
        assert.equal(missing.status, 400);
        assert.equal(missing.data.error, 'This campaign has no message available to test.');
        console.log('campaign-test-media smoke: all checks passed');
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
