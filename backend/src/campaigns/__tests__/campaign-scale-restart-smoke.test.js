const assert = require('node:assert/strict');
const db = require('../../database/db');
const contactService = require('../../contacts/contactService');
const excelParser = require('../excelParser');
const campaignService = require('../campaignService');
const queue = require('../messageQueue');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONTACT_TOTAL = 2500;

async function main() {
    const original = {
        insert: db.insert,
        insertMany: db.insertMany,
        getById: db.getById,
        select: db.select,
        update: db.update,
        count: db.count,
        recountCampaignCounters: db.recountCampaignCounters,
        claimCampaignToRun: db.claimCampaignToRun,
        parse: excelParser.parse,
        getValidRows: excelParser.getValidRows,
        upsertMany: contactService.upsertMany,
        findByPhone: contactService.findByPhone,
        getSender: queue._getSender,
        sleep: queue._sleep,
    };
    const contacts = [];
    const campaigns = [];
    const contactPhones = new Map();
    const sendCount = new Map();
    let stoppedAfterFirstHalf;
    const firstHalf = new Promise(resolve => { stoppedAfterFirstHalf = resolve; });

    excelParser.parse = async () => ({ phoneColumn: 'phone', rows: [] });
    excelParser.getValidRows = result => result.rows;
    excelParser.getDynamicFields = () => [];
    contactService.upsertMany = async entries => new Map(entries.map(({ phone }) => {
        const id = contactService._cleanPhone(phone);
        contactPhones.set(id, id);
        return [id, { id, phone: id, marketing_opt_in: 1 }];
    }));
    contactService.findByPhone = async phone => ({ phone, marketing_opt_in: 1 });

    db.insert = async (table, row) => {
        const inserted = { ...row, id: campaigns.length + 1, status: 'draft', processed: 0, sent: 0, failed: 0, opt_outs: 0 };
        campaigns.push(inserted);
        return inserted;
    };
    db.insertMany = async (table, rows) => {
        assert.equal(table, 'campaign_contacts');
        const inserted = rows.map((row, index) => ({ ...row, id: contacts.length + index + 1, attempts: row.attempts || 0 }));
        contacts.push(...inserted);
        return inserted;
    };
    db.getById = async (table, id, userId) => {
        assert.equal(userId, USER_ID);
        return table === 'campaigns' ? campaigns.find(row => row.id === id) || null : null;
    };
    db.claimCampaignToRun = async (userId, id, expectedStatus) => {
        const campaign = campaigns.find(row => row.id === id && row.user_id === userId && row.status === expectedStatus);
        if (!campaign) return [];
        campaign.status = 'running';
        return [campaign];
    };
    db.select = async (table, _columns, where, params, _order, limit = 1000, offset = 0) => {
        if (table === 'campaigns') {
            const rows = campaigns.filter(row => row.user_id === USER_ID && ['running', 'paused'].includes(row.status));
            return rows.slice(offset, offset + limit);
        }
        assert.equal(table, 'campaign_contacts');
        const rows = contacts.filter(row => row.campaign_id === params[0]
            && row.user_id === USER_ID
            && row.status === params[2]
            && (!row.retry_at || new Date(row.retry_at) <= new Date(params[3])));
        return rows.slice(offset, offset + limit).map(row => ({
            ...row,
            contacts: { phone: contactPhones.get(row.contact_id) },
            campaigns: {},
        }));
    };
    db.update = async (table, data, where, params) => {
        if (table === 'campaigns') {
            const campaign = campaigns.find(row => row.id === params[0] && row.user_id === params[1]);
            if (campaign) Object.assign(campaign, data);
            return campaign ? [campaign] : [];
        }
        const [firstParam, userId, oldStatus] = params;
        const rows = contacts.filter(row => (where.startsWith('id = ?')
            ? row.id === firstParam
            : row.campaign_id === firstParam)
            && row.user_id === userId
            && (!oldStatus || row.status === oldStatus));
        for (const row of rows) Object.assign(row, data);
        return rows;
    };
    db.count = async (table, where, params) => {
        assert.equal(table, 'campaign_contacts');
        if (where.includes("status IN ('pending', 'processing')")) {
            return contacts.filter(row => row.campaign_id === params[0]
                && row.user_id === params[1]
                && ['pending', 'processing'].includes(row.status)).length;
        }
        return 0;
    };
    db.recountCampaignCounters = async (campaignId, userId) => {
        const rows = contacts.filter(row => row.campaign_id === campaignId && row.user_id === userId);
        const sent = rows.filter(row => row.status === 'sent').length;
        const failed = rows.filter(row => row.status === 'failed').length;
        const opt_outs = rows.filter(row => row.status === 'opted_out').length;
        const skipped = rows.filter(row => row.status === 'skipped').length;
        return { sent, failed, opt_outs, skipped, processed: sent + failed + opt_outs + skipped };
    };

    queue._getSender = async () => async phone => {
        sendCount.set(phone, (sendCount.get(phone) || 0) + 1);
        if (sendCount.size === CONTACT_TOTAL / 2) {
            queue._worker(USER_ID)._running = false;
            stoppedAfterFirstHalf();
        }
        return { id: `provider-${phone}` };
    };
    queue._sleep = async () => {};
    queue.setIO({ to: () => ({ emit: () => {} }) });
    queue._queues.clear();

    try {
        const rows = Array.from({ length: CONTACT_TOTAL }, (_, index) => {
            const phone = `1555${String(index).padStart(7, '0')}`;
            return { phone, _phone: phone, _rowIndex: index + 1, name: `Contact ${index + 1}` };
        });
        excelParser.parse = async () => ({ phoneColumn: 'phone', rows });
        const campaign = await campaignService.create(USER_ID, {
            name: '2,500 contact restart smoke',
            templateMessage: 'Hello {{name}}',
            filePath: 'mock.xlsx',
            settings: { businessHoursEnabled: false, maxPerHour: 0, maxPerDay: 0, delayBetweenMessages: 1 },
            countryCode: '1',
        });
        assert.equal(campaign.total_contacts, CONTACT_TOTAL);
        assert.equal(contacts.length, CONTACT_TOTAL, 'all campaign contacts were inserted in batches');

        await queue.start(campaign.id, JSON.parse(campaign.settings), USER_ID);
        let timeout;
        await Promise.race([
            firstHalf,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`queue did not reach its simulated restart point (sent ${sendCount.size})`)), 5000);
            }),
        ]);
        clearTimeout(timeout);
        await queue._worker(USER_ID)._processPromise;
        assert.equal(sendCount.size, CONTACT_TOTAL / 2, 'first worker stopped after half the contacts');
        queue._queues.clear();

        const result = await queue.resumeInterrupted({ to: () => ({ emit: () => {} }) });
        assert.equal(result.ok, true);
        const deadline = Date.now() + 30000;
        while (campaign.status !== 'completed' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(campaign.status, 'completed', 'resumed queue completes');
        assert.equal(sendCount.size, CONTACT_TOTAL, 'every contact was sent');
        assert.ok([...sendCount.values()].every(count => count === 1), 'each contact was sent exactly once');
        assert.equal(contacts.filter(row => row.status === 'sent').length, CONTACT_TOTAL);
        console.log('Campaign scale/restart smoke test passed (2,500 contacts sent once)');
    } finally {
        queue._queues.clear();
        Object.assign(db, {
            insert: original.insert,
            insertMany: original.insertMany,
            getById: original.getById,
            select: original.select,
            update: original.update,
            count: original.count,
            recountCampaignCounters: original.recountCampaignCounters,
            claimCampaignToRun: original.claimCampaignToRun,
        });
        Object.assign(excelParser, { parse: original.parse, getValidRows: original.getValidRows });
        contactService.upsertMany = original.upsertMany;
        contactService.findByPhone = original.findByPhone;
        queue._getSender = original.getSender;
        queue._sleep = original.sleep;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
