const assert = require('node:assert/strict');
const express = require('express');
const db = require('../../database/db');
const campaignService = require('../campaignService');
const campaignMediaStorage = require('../campaignMediaStorage');
const campaignRoutes = require('../../routes/campaigns');

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function main() {
    const original = {
        getById: db.getById,
        insert: db.insert,
        insertMany: db.insertMany,
        select: db.select,
        update: db.update,
        del: db.del,
        deleteCampaignMedia: campaignMediaStorage.deleteCampaignMedia,
    };
    const campaigns = new Map();
    const memberships = [];
    let nextCampaignId = 100;
    const source = {
        id: 7,
        user_id: USER_A,
        name: 'Original',
        status: 'completed_with_errors',
        template_message: 'Hello {{name}} in {{city}}',
        settings: { delayBetweenMessages: 17500, maxPerHour: 50 },
        buttons: [{ type: 'quick_reply', text: 'Yes' }],
        provider: 'web',
        media_path: 'storage-url',
        media_bucket: 'campaign-media',
        media_object_path: 'media/shared.png',
        media_type: 'image',
        media_filename: 'shared.png',
        media_mimetype: 'image/png',
    };
    campaigns.set(source.id, source);
    const originalRecipients = [
        { id: 1, campaign_id: 7, contact_id: 11, status: 'sent', contacts: { id: 11, name: 'Ada', city: 'Pune', marketing_opt_in: true } },
        { id: 2, campaign_id: 7, contact_id: 12, status: 'pending', contacts: { id: 12, name: 'Ben', city: 'Goa', marketing_opt_in: true } },
        { id: 3, campaign_id: 7, contact_id: 13, status: 'skipped', contacts: { id: 13, name: 'Cam', city: 'Mysore', marketing_opt_in: true } },
        { id: 4, campaign_id: 7, contact_id: 14, status: 'failed', contacts: { id: 14, name: 'Dee', city: 'Hubli', marketing_opt_in: true } },
        { id: 5, campaign_id: 7, contact_id: 15, status: 'opted_out', contacts: { id: 15, name: 'Eli', city: 'Udupi', marketing_opt_in: false } },
    ];
    let mediaDeleteCount = 0;
    let pendingUpdate;

    db.getById = async (table, id, userId) => {
        if (table !== 'campaigns') return null;
        const campaign = campaigns.get(Number(id));
        return campaign?.user_id === userId ? { ...campaign } : null;
    };
    db.insert = async (_table, row) => {
        const inserted = {
            ...row,
            settings: JSON.parse(row.settings),
            buttons: JSON.parse(row.buttons),
            id: nextCampaignId++,
            status: 'draft',
        };
        campaigns.set(inserted.id, inserted);
        return inserted;
    };
    db.insertMany = async (_table, rows) => {
        memberships.push(...rows);
        return rows;
    };
    db.select = async (table, _columns, where, params, _order, limit = 100, offset = 0) => {
        if (table === 'campaigns') {
            return [...campaigns.values()].filter(row => row.user_id === params[0]
                && row.media_bucket === params[1]
                && row.media_object_path === params[2]
                && row.id !== Number(params[3])).slice(offset, offset + limit);
        }
        if (where.includes('contacts(*)')) return [];
        if (where.includes('campaign_id = ?') && table === 'campaign_contacts') {
            let rows = originalRecipients.filter(row => row.campaign_id === params[0] && USER_A === params[1]);
            if (where.includes('status = ?')) rows = rows.filter(row => row.status === params[2]);
            if (where.includes('status IN')) rows = rows.filter(row => ['pending', 'skipped', 'failed'].includes(row.status));
            return rows.slice(offset, offset + limit);
        }
        if (where.includes('status = ?') && table === 'campaign_contacts') {
            return originalRecipients.filter(row => row.status === params[1]).slice(offset, offset + limit);
        }
        return [];
    };
    db.update = async (table, data, where, params) => {
        if (table === 'campaigns') {
            const row = campaigns.get(Number(params[0]));
            if (row?.user_id === params[1]) Object.assign(row, data);
            return row ? [row] : [];
        }
        pendingUpdate = { data, where, params };
        return [{ id: params[0], ...data }];
    };
    db.del = async (_table, _where, params) => {
        campaigns.delete(Number(params[0]));
        return [];
    };
    campaignMediaStorage.deleteCampaignMedia = async () => { mediaDeleteCount++; };

    try {
        const result = await campaignService.duplicate(7, USER_A);
        assert.equal(result.campaign.status, 'draft');
        assert.equal(result.campaign.name, 'Original (copy)');
        assert.equal(result.campaign.source_campaign_id, 7);
        assert.deepEqual(result.campaign.settings, source.settings);
        assert.deepEqual(result.campaign.buttons, source.buttons);
        assert.equal(result.campaign.media_bucket, source.media_bucket);
        assert.equal(result.campaign.media_object_path, source.media_object_path);
        assert.equal(result.campaign.media_filename, source.media_filename);
        assert.equal(result.skippedOptedOut, 1);
        const copied = memberships.splice(0);
        assert.equal(copied.length, 4);
        assert.ok(copied.every(row => row.status === 'pending'));
        assert.equal(copied[0].rendered_message, 'Hello Ada in Pune');

        const unsent = await campaignService.duplicate(7, USER_A, { contacts: 'unsent' });
        const unsentRows = memberships.splice(0);
        assert.equal(unsentRows.length, 3, 'unsent includes pending, skipped, and failed only; opted-out rows remain skipped');
        assert.deepEqual(new Set(unsentRows.map(row => row.contact_id)), new Set([12, 13, 14]));
        assert.equal(unsent.campaign.total_contacts, 3);

        const excluding = await campaignService.duplicate(7, USER_A, { excludeMessaged: true });
        assert.equal(excluding.excludedMessaged, 1, 'contacts already sent in an earlier campaign are reported');
        assert.equal(campaigns.get(excluding.campaign.id).total_contacts, 3);
        memberships.splice(0);

        await assert.rejects(campaignService.duplicate(7, USER_B), error => error.statusCode === 404);
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.user = { id: USER_B }; next(); });
        app.use('/api/campaigns', campaignRoutes);
        const server = app.listen(0);
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/campaigns/7/duplicate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contacts: 'all' }),
            });
            assert.equal(response.status, 404, 'campaign owner mismatch is hidden as not found at the API');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }

        const draftId = unsent.campaign.id;
        const draft = campaigns.get(draftId);
        draft.status = 'draft';
        db.select = async (table, _columns, where) => table === 'campaign_contacts' && where.includes('status = ?')
            ? [{ id: 88, contacts: { name: 'Ben', city: 'Goa' } }]
            : [];
        const updated = await campaignService.updateDraft(draftId, USER_A, { template_message: 'Changed {{name}}' });
        assert.equal(updated.template_message, 'Changed {{name}}');
        assert.equal(pendingUpdate.data.rendered_message, 'Changed Ben');
        draft.status = 'running';
        await assert.rejects(campaignService.updateDraft(draftId, USER_A, { name: 'blocked' }), /Only draft campaigns can be edited/);
        draft.status = 'completed';
        await assert.rejects(campaignService.updateDraft(draftId, USER_A, { name: 'blocked' }), /Only draft campaigns can be edited/);

        campaigns.set(30, { ...source, id: 30, name: 'Shared media reference', status: 'draft' });
        const originalSelect = db.select;
        db.select = async (table, _columns, where, params) => table === 'campaigns' && where.includes('media_object_path')
            ? [{ id: 30 }]
            : [];
        await campaignService.delete(7, USER_A);
        assert.equal(mediaDeleteCount, 0, 'deleting one campaign keeps media referenced by another campaign');
        db.select = originalSelect;
        console.log('Campaign duplicate/edit smoke test passed');
    } finally {
        Object.assign(db, {
            getById: original.getById,
            insert: original.insert,
            insertMany: original.insertMany,
            select: original.select,
            update: original.update,
            del: original.del,
        });
        campaignMediaStorage.deleteCampaignMedia = original.deleteCampaignMedia;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
