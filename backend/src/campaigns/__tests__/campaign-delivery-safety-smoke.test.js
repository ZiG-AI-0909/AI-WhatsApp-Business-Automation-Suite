// =============================================================
// Smoke test — campaign delivery safety.
//
// Runs the real queue, rate limiter, db.js, services and webhook route
// against an in-memory Supabase with a fake clock (sleeping advances
// it). Covers retries with exponential backoff and Retry-After,
// permanent failures, rate-limit pause and its resume hold, duplicate
// prevention (atomic claims, interrupted sends, reused message ids),
// opt-outs (before and during a campaign, WhatsApp 131050, STOP/START
// replies, re-opt-in guard), failure-rate pauses, recipient local hours,
// batch cooldown, approved templates, provider health and tier caps,
// delivery receipts and quality webhooks, restart recovery and the
// official typing indicator.
// =============================================================
process.env.SUPABASE_URL = 'https://campaign-safety-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'b'.repeat(64);
process.env.WABA_APP_SECRET = 'test-app-secret';
delete process.env.AI_API_KEY;
delete process.env.WABA_TYPING_INDICATOR;

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createFakeSupabase, installFakeSupabase, campaignRpcs } = require('../../database/__tests__/fakeSupabase');

const fake = createFakeSupabase({ rpc: campaignRpcs });
installFakeSupabase(fake);
const { store } = fake;

const db = require('../../database/db');
const { setCampaignDeliveryMigrationAvailable } = require('../../database/campaignDeliveryMigrationGuard');
const queue = require('../messageQueue');
const campaignService = require('../campaignService');
const contactService = require('../../contacts/contactService');
const deliveryTracker = require('../deliveryTracker');
const sendPolicy = require('../sendPolicy');
const RateLimiter = require('../rateLimiter');
const { sanitizeCampaignSettings } = require('../campaignSettings');
const { nextSendWindow, timezonesForPhone } = require('../recipientTime');
const providerRegistry = require('../../whatsapp/providerRegistry');
const sessionManager = require('../../whatsapp/sessionManager');
const businessApiProvider = require('../../whatsapp/businessApiProvider');
const incomingMessageService = require('../../conversations/incomingMessageService');
const aiService = require('../../ai/aiService');
const knowledgeBase = require('../../ai/knowledgeBase');

setCampaignDeliveryMigrationAvailable(true);

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAST = { businessHoursEnabled: false, maxPerHour: 0, maxPerDay: 0, delayBetweenMessages: 1, retryCount: 3, retryDelay: 1000 };

// ── Fake clock: every queue sleep advances it ─────────────────
let clock = Date.parse('2030-01-07T06:00:00Z'); // a Monday
queue._now = () => new Date(clock);
queue._sleep = async (ms) => {
    clock += Math.max(1, Math.round(Number(ms) || 0)); // whole ms, like Date
    await new Promise(resolve => setImmediate(resolve));
};

const events = [];
const io = { to: room => ({ emit: (event, data) => events.push({ room, event, data }) }) };
queue.setIO(io);
deliveryTracker.setIO(io);
const ownEvents = name => events.filter(item => item.room === `user:${USER}` && item.event === name);

// Provider health is stubbed (no network); tests set it per scenario.
let phoneHealth = null;
businessApiProvider.getPhoneHealth = async () => phoneHealth;
sessionManager.getStatus = () => 'connected';

function resetWorld() {
    for (const key of Object.keys(store)) delete store[key];
    queue._queues.clear();
    events.length = 0;
    phoneHealth = null;
}

function seedCampaign({ id, provider = 'web', status = 'draft', settings = {}, recipients }) {
    store.campaigns ||= [];
    store.contacts ||= [];
    store.campaign_contacts ||= [];
    store.campaigns.push({
        id, user_id: USER, name: `Campaign ${id}`, status, provider, settings: JSON.stringify(settings),
        template_message: 'Hello {{name}}', total_contacts: recipients.length,
        processed: 0, sent: 0, failed: 0, opt_outs: 0, skipped: 0, buttons: '[]', resume_after: null,
    });
    return recipients.map((recipient, index) => {
        const id2 = id * 100 + index + 1;
        store.contacts.push({
            id: id2, user_id: USER, phone: recipient.phone, name: recipient.name || `Contact ${index + 1}`,
            marketing_opt_in: recipient.optIn === false ? 0 : 1, tags: '[]',
        });
        const row = {
            id: id2, campaign_id: id, contact_id: id2, user_id: USER,
            rendered_message: `Hello ${recipient.name || ''}`.trim(),
            status: recipient.status || 'pending', attempts: recipient.attempts || 0,
            provider_message_id: recipient.providerMessageId || null,
            contact_data: recipient.data || { name: recipient.name || '' },
            retry_at: null, last_error: null, sent_at: recipient.sentAt || null, delivery_status: null,
        };
        store.campaign_contacts.push(row);
        return row;
    });
}

const row = id => store.campaign_contacts.find(item => item.id === id);
const campaign = id => store.campaigns.find(item => item.id === id);
const contactByPhone = phone => store.contacts.find(item => item.phone === phone);

function apiError(status, code, { message = 'WhatsApp error', headers = {} } = {}) {
    return Object.assign(new Error(message), {
        response: { status, headers, data: { error: { code, message } } },
    });
}

async function runCampaign(id, settings, sender) {
    queue._getSender = async () => sender;
    queue._queues.delete(USER);
    await queue.start(id, settings, USER);
    const worker = queue._worker(USER);
    await worker._processPromise;
    return worker;
}

async function runUntil(worker, predicate, maxTicks = 500_000) {
    for (let tick = 0; tick < maxTicks && !predicate(); tick++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(predicate(), 'condition was reached before the tick budget');
    worker._running = false;
    await worker._processPromise;
}

const results = [];
async function check(label, fn) {
    try {
        resetWorld();
        await fn();
        results.push(`ok   ${label}`);
    } catch (error) {
        results.push(`FAIL ${label}`);
        throw error;
    }
}

async function main() {
    try {
        await check('send policy: classification, backoff, failure window, local time', async () => {
            const kind = error => sendPolicy.classifySendError(error);
            const limited = kind(apiError(429, 130429, { headers: { 'retry-after': '30' } }));
            assert.equal(limited.pauseReason, 'rate_limited');
            assert.equal(limited.retryAfterMs, 30_000);
            assert.equal(kind(apiError(400, 131048)).pauseReason, 'account_restricted');
            assert.equal(kind(apiError(400, 368)).pauseReason, 'account_restricted');
            assert.equal(kind(apiError(401, 190)).pauseReason, 'provider_auth_failed');
            assert.equal(kind(apiError(400, 131047)).pauseReason, 'template_required');
            assert.equal(kind(apiError(400, 132001)).pauseReason, 'template_error');
            assert.equal(kind(apiError(400, 131050)).kind, 'opt_out');
            const pairLimit = kind(apiError(400, 131056));
            assert.equal(pairLimit.kind, 'retry');
            assert.equal(pairLimit.minDelayMs, 60_000);
            assert.equal(kind(apiError(400, 131026)).kind, 'permanent');
            assert.equal(kind(apiError(400, 100)).kind, 'permanent');
            assert.equal(kind(apiError(503)).kind, 'retry');
            assert.equal(kind(apiError(500, 131000)).kind, 'retry');
            assert.equal(kind(new Error('WhatsApp number is not registered: 9198')).kind, 'not_registered');
            assert.equal(kind(Object.assign(new Error('rate-overlimit'), { output: { statusCode: 429 } })).pauseReason, 'rate_limited');
            assert.equal(kind(new Error('socket hang up')).kind, 'retry');
            assert.equal(queue.shouldRetrySendError({ response: { status: 503 } }), true);
            assert.equal(queue.shouldRetrySendError({ response: { status: 400 } }), false);

            assert.equal(sendPolicy.backoffDelayMs({ baseMs: 1000, attempt: 1 }), 1000);
            assert.equal(sendPolicy.backoffDelayMs({ baseMs: 1000, attempt: 3 }), 4000);
            assert.equal(sendPolicy.backoffDelayMs({ baseMs: 1000, attempt: 30 }), 3_600_000);
            assert.equal(sendPolicy.backoffDelayMs({ baseMs: 1000, attempt: 1, retryAfterMs: 120_000 }), 120_000);
            assert.equal(sendPolicy.backoffDelayMs({ baseMs: 1000, attempt: 1, minDelayMs: 60_000 }), 60_000);
            const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
            const parsed = sendPolicy.retryAfterMs({ response: { headers: { 'retry-after': inTwoMinutes } } });
            assert.ok(parsed > 110_000 && parsed <= 120_000, `HTTP-date Retry-After parsed as ${parsed}`);

            const window = new sendPolicy.FailureWindow();
            for (let i = 0; i < 9; i++) window.record('failed');
            assert.equal(window.check(), null, 'needs at least 10 samples');
            window.reset();
            for (let i = 0; i < 5; i++) { window.record('sent'); window.record('failed'); }
            assert.equal(window.check().reason, 'high_failure_rate');
            window.reset();
            for (let i = 0; i < 6; i++) window.record('sent');
            for (let i = 0; i < 4; i++) window.record('not_registered');
            assert.equal(window.check().reason, 'many_unregistered_numbers');

            assert.deepEqual(timezonesForPhone('447700900123'), ['Europe/London']);
            assert.deepEqual(timezonesForPhone('919800000001'), ['Asia/Kolkata']);
            assert.deepEqual(timezonesForPhone('15551234567'), ['America/New_York', 'America/Los_Angeles']);
            assert.deepEqual(timezonesForPhone('99912345'), []);
            const hours = new RateLimiter({ businessHoursStart: '09:30', businessHoursEnd: '18:30', businessDays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata' }).settings;
            const monday0600 = new Date('2030-01-07T06:00:00Z');
            assert.equal(nextSendWindow(hours, '919800000001', monday0600).at.toISOString(), '2030-01-07T06:00:00.000Z');
            assert.equal(nextSendWindow(hours, '447700900123', monday0600).at.toISOString(), '2030-01-07T09:30:00.000Z');
            assert.equal(nextSendWindow(hours, '15551234567', monday0600).at, null, 'no overlap with US hours');

            assert.equal(providerRegistry.CAPABILITIES.web.official, false);
            assert.equal(providerRegistry.CAPABILITIES.web.typingIndicator, false);
            assert.equal(providerRegistry.CAPABILITIES.business.official, true);
            assert.equal(providerRegistry.CAPABILITIES.business.typingIndicator, 'replies_only');

            assert.throws(() => sanitizeCampaignSettings({ waTemplate: { name: 'Dealer Offer' } }), error => error.statusCode === 400);
            assert.deepEqual(sanitizeCampaignSettings({ cooldownEvery: '5000', cooldownMinutes: 0, failureRatePauseThreshold: 7 }), {
                cooldownEvery: 1000, cooldownMinutes: 1, failureRatePauseThreshold: 1,
            });
        });

        await check('retries: exponential backoff, same message id, then sent once', async () => {
            const [recipient] = seedCampaign({ id: 11, recipients: [{ phone: '919811000001', name: 'Asha' }] });
            const delays = [];
            const ids = [];
            const realUpdate = db.update;
            db.update = async (table, data, where, params) => {
                if (table === 'campaign_contacts' && data.status === 'pending' && data.retry_at) delays.push(data.retry_at.getTime() - clock);
                return realUpdate(table, data, where, params);
            };
            try {
                await runCampaign(11, FAST, async (_phone, _body, _media, _buttons, options) => {
                    ids.push(options.messageId);
                    if (ids.length <= 2) throw apiError(503, undefined, { message: 'Service unavailable' });
                    return { key: { id: options.messageId } };
                });
            } finally {
                db.update = realUpdate;
            }
            assert.equal(ids.length, 3);
            assert.deepEqual(delays, [1000, 2000], 'retry delays double');
            assert.match(ids[0], /^3EB0[0-9A-F]{18}$/);
            assert.equal(new Set(ids).size, 1, 'every attempt reuses one WhatsApp message id');
            assert.equal(row(recipient.id).status, 'sent');
            assert.equal(row(recipient.id).attempts, 3);
            assert.equal(row(recipient.id).provider_message_id, ids[0]);
            assert.equal(campaign(11).status, 'completed');
        });

        await check('retries honour a server Retry-After', async () => {
            seedCampaign({ id: 12, recipients: [{ phone: '919811000002' }] });
            const delays = [];
            const realUpdate = db.update;
            db.update = async (table, data, where, params) => {
                if (table === 'campaign_contacts' && data.status === 'pending' && data.retry_at) delays.push(data.retry_at.getTime() - clock);
                return realUpdate(table, data, where, params);
            };
            let calls = 0;
            try {
                await runCampaign(12, FAST, async (_p, _b, _m, _bt, options) => {
                    calls += 1;
                    if (calls === 1) throw apiError(503, undefined, { headers: { 'retry-after': '120' } });
                    return { key: { id: options.messageId } };
                });
            } finally {
                db.update = realUpdate;
            }
            assert.deepEqual(delays, [120_000]);
            assert.equal(calls, 2);
        });

        await check('permanent failures are never retried', async () => {
            const [recipient] = seedCampaign({ id: 13, recipients: [{ phone: '919811000003' }] });
            let calls = 0;
            await runCampaign(13, FAST, async () => { calls += 1; throw apiError(400, 131026, { message: 'Message undeliverable' }); });
            assert.equal(calls, 1);
            assert.equal(row(recipient.id).status, 'failed');
            assert.equal(row(recipient.id).retry_at, null);
            assert.match(row(recipient.id).last_error, /undeliverable/);
            assert.equal(campaign(13).status, 'failed');
        });

        await check('rate limit pauses; resume is held until the cooldown, then nothing is resent', async () => {
            const [first, second] = seedCampaign({ id: 14, recipients: [{ phone: '919811000004' }, { phone: '919811000005' }] });
            let rateLimited = true;
            const sent = [];
            const sender = async (phone, _b, _m, _bt, options) => {
                if (rateLimited) throw apiError(429, 130429, { headers: { 'retry-after': '30' } });
                sent.push(phone);
                return { key: { id: options.messageId } };
            };
            await runCampaign(14, FAST, sender);
            assert.equal(campaign(14).status, 'paused');
            assert.equal(campaign(14).pause_reason, 'rate_limited');
            const resumeAfter = new Date(campaign(14).resume_after).getTime();
            assert.ok(resumeAfter >= Date.now() + 14 * 60_000, 'at least 15 minutes even when Retry-After is shorter');
            assert.equal(row(first.id).status, 'pending');
            assert.equal(row(first.id).attempts, 0, 'the rate-limited attempt is not counted against the recipient');
            assert.equal(queue._worker(USER), null, 'paused worker is unloaded');
            assert.equal(ownEvents('campaign:paused')[0].data.reason, 'rate_limited');

            await assert.rejects(campaignService.resume(14, io, USER), error => error.statusCode === 409 && /rate-limited/.test(error.message));
            campaign(14).resume_after = new Date(Date.now() - 1000).toISOString();
            rateLimited = false;
            queue._getSender = async () => sender;
            await campaignService.resume(14, io, USER);
            await queue._worker(USER)?._processPromise;
            assert.deepEqual(sent, ['919811000004', '919811000005'], 'each recipient sent exactly once');
            assert.equal(row(second.id).status, 'sent');
            assert.equal(campaign(14).status, 'completed');
            assert.equal(campaign(14).resume_after, null, 'cooldown cleared once resumed');
        });

        await check('restart: sent rows are not resent; interrupted send is held, then confirmed by its receipt', async () => {
            const [, interrupted, pending] = seedCampaign({
                id: 15,
                status: 'running',
                recipients: [
                    { phone: '919811000006', status: 'sent', providerMessageId: '3EB0AAAAAAAAAAAAAAAAAA', sentAt: '2030-01-07T05:00:00Z' },
                    { phone: '919811000007', status: 'processing', providerMessageId: '3EB0BBBBBBBBBBBBBBBBBB', attempts: 1 },
                    { phone: '919811000008' },
                ],
            });
            const sentTo = [];
            queue._getSender = async () => async (phone, _b, _m, _bt, options) => { sentTo.push(phone); return { key: { id: options.messageId } }; };
            const result = await queue.resumeInterrupted(io);
            assert.equal(result.resumed, 15);
            await queue._worker(USER)?._processPromise;
            assert.deepEqual(sentTo, ['919811000008'], 'only the pending recipient is sent');
            assert.equal(row(pending.id).status, 'sent');
            assert.equal(row(interrupted.id).status, 'failed');
            assert.ok(row(interrupted.id).last_error.startsWith(deliveryTracker.INTERRUPTED_PREFIX));
            assert.equal(campaign(15).status, 'completed_with_errors');

            await deliveryTracker.applyReceipt(USER, { messageId: '3EB0BBBBBBBBBBBBBBBBBB', status: 'delivered' });
            await deliveryTracker.flush();
            assert.equal(row(interrupted.id).status, 'sent', 'receipt proves the interrupted message went out');
            assert.equal(row(interrupted.id).delivery_status, 'delivered');
            assert.equal(row(interrupted.id).last_error, null);
            assert.equal(campaign(15).sent, 3);
            assert.equal(campaign(15).failed, 0);
            assert.equal(campaign(15).delivered, 1);
        });

        await check('a recipient claimed by another worker is never sent twice', async () => {
            const [taken, free] = seedCampaign({ id: 16, recipients: [{ phone: '919811000009' }, { phone: '919811000010' }] });
            const realSelect = db.select;
            let stolen = false;
            db.select = async (...args) => {
                const rows = await realSelect(...args);
                if (!stolen && args[0] === 'campaign_contacts' && rows?.[0]?.id === taken.id && args[3]?.[2] === 'pending') {
                    row(taken.id).status = 'processing'; // another instance claims it first
                    stolen = true;
                }
                return rows;
            };
            const sentTo = [];
            try {
                queue._getSender = async () => async (phone, _b, _m, _bt, options) => { sentTo.push(phone); return { key: { id: options.messageId } }; };
                await queue.start(16, FAST, USER);
                await runUntil(queue._worker(USER), () => sentTo.length === 1 && row(free.id).status === 'sent');
            } finally {
                db.select = realSelect;
            }
            assert.deepEqual(sentTo, ['919811000010']);
            assert.equal(row(taken.id).status, 'processing', 'left to the worker that claimed it');
        });

        await check('opt-outs: never sent before consent, STOP mid-campaign, WhatsApp 131050, re-opt-in guard', async () => {
            const [first, stopsMidway, neverConsented, whatsappOptOut] = seedCampaign({
                id: 17,
                recipients: [
                    { phone: '919811000011', name: 'First' },
                    { phone: '919811000012', name: 'Replies STOP' },
                    { phone: '919811000013', name: 'No consent', optIn: false },
                    { phone: '919811000014', name: 'WhatsApp opt-out' },
                ],
            });
            const sentTo = [];
            await runCampaign(17, FAST, async (phone, _b, _m, _bt, options) => {
                sentTo.push(phone);
                if (phone === '919811000011') await contactService.setOptOut('919811000012', USER, 'reply');
                if (phone === '919811000014') throw apiError(400, 131050, { message: 'User has stopped marketing messages' });
                return { key: { id: options.messageId } };
            });
            assert.deepEqual(sentTo, ['919811000011', '919811000014']);
            assert.equal(row(first.id).status, 'sent');
            assert.equal(row(stopsMidway.id).status, 'opted_out');
            assert.equal(row(neverConsented.id).status, 'opted_out');
            assert.equal(row(whatsappOptOut.id).status, 'opted_out');
            const stopped = contactByPhone('919811000012');
            assert.equal(stopped.marketing_opt_in, 0);
            assert.equal(stopped.opt_out_source, 'reply');
            assert.ok(stopped.opted_out_at);
            assert.equal(contactByPhone('919811000014').opt_out_source, 'whatsapp');
            assert.equal(campaign(17).status, 'completed');
            assert.equal(campaign(17).opt_outs, 3);

            await assert.rejects(
                contactService.update(stopped.id, { marketing_opt_in: true }, USER),
                error => error.statusCode === 409 && error.code === 'OPTED_OUT',
            );
            assert.equal(contactByPhone('919811000012').marketing_opt_in, 0, 'still opted out');
            const reconsented = await contactService.update(stopped.id, { marketing_opt_in: true, confirm_resubscribe: true }, USER);
            assert.equal(reconsented.marketing_opt_in, 1);
            assert.equal(reconsented.opt_in_source, 'manual');
            assert.ok(new Date(reconsented.opted_in_at) >= new Date(reconsented.opted_out_at));
        });

        await check('STOP and START replies record consent', async () => {
            const replies = [];
            const send = async (phone, body) => { replies.push({ phone, body }); return {}; };
            await incomingMessageService.process({ provider: 'web', from: '919811000015', body: 'STOP', id: 'in-1', contact: { name: 'Replier' } }, USER, io, send);
            let contact = contactByPhone('919811000015');
            assert.equal(contact.marketing_opt_in, 0);
            assert.equal(contact.opt_out_source, 'reply');
            assert.match(replies[0].body, /unsubscribed/i);
            await incomingMessageService.process({ provider: 'web', from: '919811000015', body: 'START', id: 'in-2', contact: { name: 'Replier' } }, USER, io, send);
            contact = contactByPhone('919811000015');
            assert.equal(contact.marketing_opt_in, 1);
            assert.equal(contact.opt_in_source, 'reply');
            assert.match(replies[1].body, /subscribed .* again/i);
        });

        await check('failure share over the last 20 attempts pauses the campaign', async () => {
            const recipients = Array.from({ length: 20 }, (_, i) => ({ phone: `9198112000${String(i).padStart(2, '0')}` }));
            seedCampaign({ id: 18, recipients });
            let calls = 0;
            await runCampaign(18, FAST, async (_phone, _b, _m, _bt, options) => {
                calls += 1;
                if (calls % 2 === 0) throw apiError(400, 131026, { message: 'Message undeliverable' });
                return { key: { id: options.messageId } };
            });
            assert.equal(campaign(18).status, 'paused');
            assert.equal(campaign(18).pause_reason, 'high_failure_rate');
            assert.equal(calls, 10, 'stopped after 10 attempts with half failing');
            assert.equal(store.campaign_contacts.filter(item => item.campaign_id === 18 && item.status === 'pending').length, 10);
        });

        await check('many numbers not on WhatsApp pause the campaign', async () => {
            const recipients = Array.from({ length: 12 }, (_, i) => ({ phone: `9198113000${String(i).padStart(2, '0')}` }));
            seedCampaign({ id: 19, recipients });
            let calls = 0;
            await runCampaign(19, FAST, async (phone, _b, _m, _bt, options) => {
                calls += 1;
                if (calls > 6) throw new Error(`WhatsApp number is not registered: ${phone}`);
                return { key: { id: options.messageId } };
            });
            assert.equal(campaign(19).pause_reason, 'many_unregistered_numbers');
            assert.equal(calls, 10);
        });

        await check('recipient local hours: defer to their 09:30, skip countries with no overlap', async () => {
            clock = Date.parse('2030-01-07T06:00:00Z'); // 11:30 in India, 06:00 in London
            const [india, uk, us] = seedCampaign({
                id: 20,
                recipients: [{ phone: '919811400001' }, { phone: '447700900123' }, { phone: '15551234567' }],
            });
            const settings = {
                ...FAST,
                businessHoursEnabled: true, businessHoursStart: '09:30', businessHoursEnd: '18:30',
                businessDays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata', respectRecipientTimezone: true,
            };
            const sentAt = {};
            await runCampaign(20, settings, async (phone, _b, _m, _bt, options) => {
                sentAt[phone] = clock;
                return { key: { id: options.messageId } };
            });
            assert.ok(sentAt['919811400001'] < Date.parse('2030-01-07T06:01:00Z'), 'India sent right away');
            assert.ok(sentAt['447700900123'] >= Date.parse('2030-01-07T09:30:00Z'), 'UK waits for 09:30 London');
            assert.ok(sentAt['447700900123'] < Date.parse('2030-01-07T09:32:00Z'));
            assert.equal(sentAt['15551234567'], undefined);
            assert.equal(row(us.id).status, 'skipped');
            assert.match(row(us.id).last_error, /never overlap/);
            assert.equal(row(india.id).status, 'sent');
            assert.equal(row(uk.id).status, 'sent');
            assert.ok(ownEvents('campaign:waiting').some(item => item.data.waiting?.reason === 'scheduled_retries'));
            assert.equal(campaign(20).status, 'completed');
        });

        await check('batch cooldown pauses between batches', async () => {
            seedCampaign({ id: 21, recipients: [{ phone: '919811500001' }, { phone: '919811500002' }, { phone: '919811500003' }] });
            const times = [];
            await runCampaign(21, { ...FAST, cooldownEvery: 2, cooldownMinutes: 5 }, async (_p, _b, _m, _bt, options) => {
                times.push(clock);
                return { key: { id: options.messageId } };
            });
            assert.equal(times.length, 3);
            assert.ok(times[1] - times[0] < 60_000);
            assert.ok(times[2] - times[1] >= 5 * 60_000, 'third message waits for the 5-minute cooldown');
            assert.ok(ownEvents('campaign:waiting').some(item => item.data.waiting?.reason === 'cooldown'));
        });

        await check('Business API: approved template variables and delivery callback reference', async () => {
            const [recipient] = seedCampaign({
                id: 22,
                provider: 'business',
                recipients: [{ phone: '919811600001', name: 'Ravi', data: { name: 'Ravi', city: 'Pune' } }],
            });
            let options;
            await runCampaign(22, {
                ...FAST,
                waTemplate: { name: 'dealer_offer', language: 'en', bodyParams: ['{{name}}', '{{city}}', '{{missing}}', 'Diwali'] },
            }, async (_phone, _body, _media, _buttons, sendOptions) => {
                options = sendOptions;
                return { messages: [{ id: 'wamid.T1' }] };
            });
            assert.deepEqual(options.template, { name: 'dealer_offer', language: 'en', bodyParams: ['Ravi', 'Pune', '', 'Diwali'] });
            assert.equal(options.callbackData, `cc:${recipient.id}`);
            assert.equal(options.messageId, undefined, 'Cloud API assigns its own ids');
            assert.equal(row(recipient.id).provider_message_id, 'wamid.T1');
        });

        await check('Business API health: flagged number pauses, RED during a run pauses, tier caps the day', async () => {
            seedCampaign({ id: 23, provider: 'business', status: 'running', recipients: [{ phone: '919811700001' }] });
            const worker = queue._createWorker(23, USER, FAST, { provider: 'business' });
            queue._queues.set(USER, worker);
            phoneHealth = { qualityRating: 'GREEN', status: 'CONNECTED' };
            assert.equal(await worker._checkProviderHealth(), false);
            phoneHealth = { qualityRating: 'RED', status: 'CONNECTED' };
            assert.equal(await worker._checkProviderHealth(), true);
            assert.equal(campaign(23).pause_reason, 'quality_low');

            seedCampaign({ id: 24, provider: 'business', status: 'running', recipients: [{ phone: '919811700002' }] });
            const startedRed = queue._createWorker(24, USER, FAST, { provider: 'business' });
            queue._queues.set(USER, startedRed);
            phoneHealth = { qualityRating: 'RED', status: 'CONNECTED' };
            assert.equal(await startedRed._checkProviderHealth(), false, 'already RED at start: warn, do not loop-pause');
            assert.ok(ownEvents('campaign:warning').length >= 1);
            phoneHealth = { qualityRating: 'RED', status: 'FLAGGED' };
            assert.equal(await startedRed._checkProviderHealth(), true);
            assert.equal(campaign(24).pause_reason, 'quality_low');

            store.campaign_contacts.push(
                { id: 9001, campaign_id: 24, user_id: USER, status: 'sent', sent_at: new Date(clock - 3_600_000) },
                { id: 9002, campaign_id: 24, user_id: USER, status: 'sent', sent_at: new Date(clock - 7_200_000) },
            );
            const limiter = new RateLimiter({ maxPerHour: 0, maxPerDay: 175 });
            const capped = await limiter.checkDatabaseLimits(db, USER, new Date(clock), { providerDailyLimit: 2 });
            assert.deepEqual({ allowed: capped.allowed, code: capped.code }, { allowed: false, code: 'provider_daily_limit' });
            const free = await limiter.checkDatabaseLimits(db, USER, new Date(clock), { providerDailyLimit: 1000 });
            assert.equal(free.allowed, true);
        });

        await check('webhook: delivery receipts, async failures, callback adoption, quality pause, typing indicator', async () => {
            businessApiProvider.configure(USER, { phoneNumberId: 'PNID-1', displayPhoneNumber: '+91 98110 00000', accessToken: 'unused', status: 'connected' });
            const [read, notDelivered, adopted] = seedCampaign({
                id: 25,
                provider: 'business',
                status: 'completed',
                recipients: [
                    { phone: '919811800001', status: 'sent', providerMessageId: 'wamid.D1' },
                    { phone: '919811800002', status: 'sent', providerMessageId: 'wamid.D2' },
                    { phone: '919811800003', status: 'processing' },
                ],
            });
            seedCampaign({ id: 26, provider: 'business', status: 'running', recipients: [{ phone: '919811800004', status: 'sent', providerMessageId: 'wamid.E1' }] });
            seedCampaign({ id: 27, provider: 'business', status: 'running', recipients: [{ phone: '919811800005' }] });

            const app = express();
            app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
            app.use('/webhook', require('../../routes/whatsappWebhook'));
            const server = app.listen(0);
            const post = async (payload, { signed = true } = {}) => {
                const body = JSON.stringify(payload);
                const headers = { 'Content-Type': 'application/json' };
                if (signed) headers['X-Hub-Signature-256'] = `sha256=${crypto.createHmac('sha256', process.env.WABA_APP_SECRET).update(body).digest('hex')}`;
                const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, { method: 'POST', headers, body });
                return response.status;
            };
            const statusesPayload = statuses => ({
                entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID-1' }, statuses } }] }],
            });
            try {
                assert.equal(await post(statusesPayload([{ id: 'wamid.D1', status: 'read' }]), { signed: false }), 401, 'unsigned webhooks are rejected');
                assert.equal(row(read.id).delivery_status, null);

                assert.equal(await post(statusesPayload([
                    { id: 'wamid.D1', status: 'delivered', timestamp: '1893990000' },
                    { id: 'wamid.D1', status: 'read', timestamp: '1893990060' },
                    { id: 'wamid.D2', status: 'failed', errors: [{ code: 131049, title: 'Not delivered to maintain healthy ecosystem engagement' }] },
                    { id: 'wamid.D3', status: 'sent', biz_opaque_callback_data: `cc:${adopted.id}` },
                    { id: 'wamid.E1', status: 'failed', errors: [{ code: 131048, title: 'Spam rate limit hit' }] },
                ])), 200);
                await deliveryTracker.flush();
                assert.equal(row(read.id).delivery_status, 'read');
                assert.ok(row(read.id).delivered_at && row(read.id).read_at);
                assert.equal(row(notDelivered.id).status, 'failed');
                assert.equal(row(notDelivered.id).error_code, '131049');
                assert.match(row(notDelivered.id).last_error, /not delivered/i);
                assert.equal(row(adopted.id).status, 'sent', 'interrupted Cloud API send adopted via callback data');
                assert.equal(row(adopted.id).provider_message_id, 'wamid.D3');
                assert.equal(campaign(25).status, 'completed_with_errors');
                assert.equal(campaign(25).delivered, 1);
                assert.equal(campaign(25).read_count, 1);
                assert.equal(campaign(26).status, 'paused');
                assert.equal(campaign(26).pause_reason, 'account_restricted');

                assert.equal(await post({ entry: [{ id: 'WABA', changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '919811000000', event: 'FLAGGED', current_limit: 'TIER_1K' } }] }] }), 200);
                assert.equal(campaign(27).status, 'paused');
                assert.equal(campaign(27).pause_reason, 'quality_low');

                // Official typing indicator: only for replies, only when enabled.
                const order = [];
                const originalTyping = businessApiProvider.sendTypingIndicator;
                const originalSend = businessApiProvider.sendMessage;
                const originalReply = aiService.generateReply;
                const originalContext = knowledgeBase.getRelevantContext;
                businessApiProvider.sendTypingIndicator = async (_userId, messageId) => { order.push(`typing:${messageId}`); return true; };
                businessApiProvider.sendMessage = async (_userId, _phone, body) => { order.push(`reply:${body}`); return { messages: [{ id: 'wamid.R1' }] }; };
                aiService.generateReply = async () => 'We stock 110 mm HDPE pipe.';
                knowledgeBase.getRelevantContext = async () => '';
                process.env.AI_API_KEY = 'test-ai-key';
                // Existing customer conversation (the real table defaults ai_enabled to 1).
                store.contacts.push({ id: 9901, user_id: USER, phone: '919811900001', name: 'Buyer', marketing_opt_in: 1, tags: '[]' });
                store.conversations = [{ id: 9902, user_id: USER, contact_id: 9901, status: 'open', ai_enabled: 1, unread_count: 0 }];
                const inbound = (id, text) => ({
                    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
                        metadata: { phone_number_id: 'PNID-1' },
                        messages: [{ from: '919811900001', id, type: 'text', text: { body: text }, timestamp: '1893990100' }],
                    } }] }],
                });
                try {
                    assert.equal(await post(inbound('wamid.IN1', 'Do you stock 110 mm HDPE pipe?')), 200);
                    assert.deepEqual(order, ['reply:We stock 110 mm HDPE pipe.'], 'off by default');
                    order.length = 0;
                    process.env.WABA_TYPING_INDICATOR = 'true';
                    assert.equal(await post(inbound('wamid.IN2', 'And 160 mm?')), 200);
                    assert.deepEqual(order, ['typing:wamid.IN2', 'reply:We stock 110 mm HDPE pipe.']);
                } finally {
                    businessApiProvider.sendTypingIndicator = originalTyping;
                    businessApiProvider.sendMessage = originalSend;
                    aiService.generateReply = originalReply;
                    knowledgeBase.getRelevantContext = originalContext;
                    delete process.env.AI_API_KEY;
                    delete process.env.WABA_TYPING_INDICATOR;
                }
            } finally {
                server.close();
            }
        });

        await check('WhatsApp Web acks: delivered then read, never downgraded', async () => {
            const [recipient] = seedCampaign({ id: 28, status: 'completed', recipients: [{ phone: '919811950001', status: 'sent', providerMessageId: '3EB0CCCCCCCCCCCCCCCCCC' }] });
            await deliveryTracker.applyReceipt(USER, { messageId: '3EB0CCCCCCCCCCCCCCCCCC', status: 'read' });
            await deliveryTracker.applyReceipt(USER, { messageId: '3EB0CCCCCCCCCCCCCCCCCC', status: 'delivered' });
            await deliveryTracker.flush();
            assert.equal(row(recipient.id).delivery_status, 'read');
            assert.equal(campaign(28).delivered, 1);
            assert.equal(await deliveryTracker.applyReceipt(USER, { messageId: 'not-a-campaign-message', status: 'read' }), null);
        });
    } finally {
        console.log(results.join('\n'));
    }
    console.log('Campaign delivery safety smoke test passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
