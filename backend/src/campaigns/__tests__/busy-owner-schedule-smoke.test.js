// =============================================================
// Busy-owner schedule smoke test (review Task 5).
//
// Verifies, WITHOUT a live phone or real Supabase:
//   T1. Owner queue busy → schedule stays PENDING with last_error
//       'Waiting for the running campaign to finish', and 3 consecutive
//       busy polls do NOT create duplicate campaigns (the parked
//       pending_campaign_id is reused).
//   T2. After the running campaign finishes, the schedule fires ONCE
//       (status completed for 'once'; no second campaign created).
//   T3. The 24h cap past next_run_at marks the schedule 'skipped' with a
//       clear last_error.
//
// Every test FAILS on the old code, which marked ONE-time schedules
// 'failed' on the busy error and pushed recurring ones to the next cron
// slot, creating a fresh campaign on every poll.
//
// Run: node backend/src/campaigns/__tests__/busy-owner-schedule-smoke.test.js
// =============================================================
const assert = require('assert');

// ---- Shared in-memory Supabase mock (injected at the client boundary)
const state = { rows: {} };

function applyRows(rows, filters) {
    let out = rows;
    for (const f of filters) {
        if (f.op === 'eq') out = out.filter(r => String(r[f.col]) === String(f.val));
        else if (f.op === 'in') out = out.filter(r => f.vals.includes(r[f.col]));
        else if (f.op === 'lte') out = out.filter(r => new Date(r[f.col]) <= new Date(f.val));
    }
    return out.filter(Boolean);
}

function filterMethods(filters) {
    return {
        eq(col, val) { filters.push({ op: 'eq', col, val }); return this; },
        in(col, vals) { filters.push({ op: 'in', col, vals }); return this; },
        lte(col, val) { filters.push({ op: 'lte', col, val }); return this; },
        or(expr) { filters.push({ op: 'or', expr }); return this; },
    };
}

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        rows: state.rows[name],
        select(_cols) {
            const filters = [];
            const builder = {
                ...filterMethods(filters),
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => ({ data: applyRows(state.rows[name], filters)[0] || null, error: null }),
                single: async () => ({ data: applyRows(state.rows[name], filters)[0] || null, error: null }),
                then(resolve) { return resolve({ data: applyRows(state.rows[name], filters), error: null }); },
            };
            return builder;
        },
        insert(row) {
            const created = Array.isArray(row) ? row : [row];
            for (const r of created) {
                state.rows[name].push({
                    ...r,
                    id: r.id || `${name}-${state.rows[name].length + 1}`,
                    created_at: r.created_at || new Date().toISOString(),
                    ...(name === 'campaigns' && r.status === undefined ? { status: 'draft', processed: 0, sent: 0, failed: 0, replies: 0, opt_outs: 0, total_contacts: 0, media_path: null, media_type: null } : {}),
                    ...(name === 'campaign_contacts' && r.status === undefined ? { status: 'pending', attempts: 0 } : {}),
                });
            }
            const last = state.rows[name][state.rows[name].length - 1];
            return { select: () => ({ single: async () => ({ data: last, error: null }) }) };
        },
        update(_data) {
            const filters = [];
            const builder = {
                ...filterMethods(filters),
                select: async () => {
                    state.rows[name] = state.rows[name].map(r => (applyRows([r], filters).length ? { ...r, ..._data } : r));
                    return { data: applyRows(state.rows[name], filters), error: null };
                },
                then(resolve) {
                    state.rows[name] = state.rows[name].map(r => (applyRows([r], filters).length ? { ...r, ..._data } : r));
                    return resolve({ data: applyRows(state.rows[name], filters), error: null });
                },
            };
            return builder;
        },
    };
}

// Inject the mock BEFORE requiring modules that use supabaseClient.
const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: { from: (name) => table(name) },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const schedulerService = require('../schedulerService');
const campaignService = require('../campaignService');

// Owner with a live connection (owner-connect check passes)
const sessionManager = require('../../whatsapp/sessionManager');
sessionManager.getStatus = () => 'connected';

const OWNER = 'cccccccc-3333-3333-3333-333333333333';

let createdCount = 0;
const realCreate = campaignService.create.bind(campaignService);
campaignService.create = async (...args) => { createdCount += 1; return realCreate(...args); };

// Stub the Excel parse so campaign creation succeeds offline.
const campaignServiceExcel = require('../excelParser');
campaignServiceExcel.parse = async () => ({ validation: {}, phoneColumn: 'phone', validRows: [], dynamicFields: [] });
campaignServiceExcel.getValidRows = () => [{ phone: '919000000001', name: 'A', company: 'C', city: 'X' }];
campaignServiceExcel.getDynamicFields = () => [];

let startResults = [];
let startCallCount = 0;
campaignService.start = async (campaignId) => {
    startCallCount += 1;
    const result = startResults.length ? startResults.shift() : { ok: true };
    if (result.ok) {
        state.rows.campaigns = state.rows.campaigns.map(c => (c.id === campaignId ? { ...c, status: 'running' } : c));
        return;
    }
    throw new Error(result.error);
};

function fakeIO() { return { emit() {}, to() { return { emit() {} }; } }; }

function seed(over = {}) {
    state.rows.campaign_schedules = [{
        id: 'sched-busy', user_id: OWNER, name: 'busy test',
        template_message: 'hello', file_path: '/tmp/fake.xlsx',
        buttons: '[]', settings: '{}', allow_missing_fields: 1,
        schedule_type: 'once', status: 'pending',
        next_run_at: new Date(Date.now() - 60000).toISOString(),
        run_at: new Date(Date.now() - 60000).toISOString(),
        recurrence_cron: null,
    }];
    state.rows.campaigns = [];
    state.rows.contacts = [{ id: 'c1', phone: '919000000001', user_id: OWNER, marketing_opt_in: 1 }];
    state.rows.campaign_contacts = [];
    createdCount = 0;
    startCallCount = 0;
    startResults = [];
    Object.assign(state.rows.campaign_schedules[0], over);
}

const realContactServiceUpsert = require('../../contacts/contactService').upsert;
require('../../contacts/contactService').upsert = async (phone) => ({ id: 'c1', phone, marketing_opt_in: 1 });
const realContactServiceFind = require('../../contacts/contactService').findByPhone;
require('../../contacts/contactService').findByPhone = async () => ({ id: 'c1', phone: '919000000001', marketing_opt_in: 1 });

let failures = 0;
async function run(label, fn) {
    console.log(`▶ ${label}`);
    try { await fn(); console.log(`✅ ${label} passed`); }
    catch (error) { failures++; console.error(`❌ ${label} FAILED:`, error.message); }
}

// ================================================================
async function test1_busyOwnerKeepsPendingNoDuplicates() {
    seed();
    startResults = [{ ok: false, error: 'A campaign is already running. Stop or pause it first.' }];
    await schedulerService._fireDueSchedules();

    let schedule = state.rows.campaign_schedules[0];
    assert.strictEqual(schedule.status, 'pending', `busy owner must leave the schedule pending, got ${schedule.status}`);
    assert.strictEqual(schedule.last_error, 'Waiting for the running campaign to finish',
        `last_error must be the condition-specific wording, got: ${schedule.last_error}`);
    assert.strictEqual(createdCount, 1, 'one campaign created by the first busy poll');
    assert.ok(schedule.pending_campaign_id, 'created campaign must be parked on pending_campaign_id');

    // 2 more busy polls → no additional campaigns (parked one reused).
    startResults = [{ ok: false, error: 'A campaign is already running. Stop or pause it first.' }, { ok: false, error: 'A campaign is already running. Stop or pause it first.' }];
    await schedulerService._fireDueSchedules();
    await schedulerService._fireDueSchedules();

    assert.strictEqual(createdCount, 1, `3 busy polls must not create duplicate campaigns; got ${createdCount}`);
    assert.strictEqual(startCallCount, 3, 'each busy poll re-attempts start (parked campaign reused)');
    schedule = state.rows.campaign_schedules[0];
    assert.strictEqual(schedule.status, 'pending', 'still pending after 3 busy polls');
}

// ================================================================
async function test2_firesOnceAfterOwnerFrees() {
    // Continuing state: parked campaign waiting; owner finishes campaign.
    startResults = [{ ok: true }]; // queue now free
    await schedulerService._fireDueSchedules();

    const schedule = state.rows.campaign_schedules[0];
    assert.strictEqual(schedule.status, 'completed', `once-schedule must complete after the owner frees, got ${schedule.status}`);
    assert.strictEqual(createdCount, 1, `exactly one campaign in total (no duplicate on the firing poll); got ${createdCount}`);
    assert.strictEqual(startCallCount, 3 + 1,
        `start attempts: 3 busy + 1 successful; got ${startCallCount}`);
    assert.strictEqual(schedule.last_error, null, 'last_error cleared after firing');
    assert.strictEqual(schedule.pending_campaign_id, null, 'parked reference cleared after firing');
}

// ================================================================
async function test3_busyWaitCapMarksSkipped() {
    seed({ next_run_at: new Date(Date.now() - 25 * 3600000).toISOString(), run_at: new Date(Date.now() - 25 * 3600000).toISOString() });
    startResults = [{ ok: false, error: 'A campaign is already running. Stop or pause it first.' }];
    await schedulerService._fireDueSchedules();

    const schedule = state.rows.campaign_schedules[0];
    assert.strictEqual(schedule.status, 'skipped', `after 24h+ of waiting the schedule must be skipped, got ${schedule.status}`);
    assert.ok(/still running for more than 24h/.test(schedule.last_error), `skipped reason must be clear, got: ${schedule.last_error}`);
    // The campaign created by that final attempt must not linger as a
    // duplicate: parked reference cleared on the skip path too, and no
    // second campaign is created afterwards.
    assert.ok(schedule.pending_campaign_id === undefined || schedule.pending_campaign_id === null,
        'skip path must not leave a parked campaign reference on the row');
}

(async () => {
    await run('T1: busy owner leaves schedule pending; 3 polls, no duplicate campaigns', test1_busyOwnerKeepsPendingNoDuplicates);
    await run('T2: schedule fires exactly once after the running campaign finishes', test2_firesOnceAfterOwnerFrees);
    await run('T3: 24h busy-wait cap marks the schedule skipped', test3_busyWaitCapMarksSkipped);

    if (failures) {
        console.error(`\n${failures} test(s) FAILED`);
        process.exit(1);
    }
    console.log('\n🎉 ALL BUSY-OWNER SCHEDULE SMOKE TESTS PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
