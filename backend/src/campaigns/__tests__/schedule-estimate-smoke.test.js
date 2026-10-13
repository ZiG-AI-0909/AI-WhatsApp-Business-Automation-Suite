// =============================================================
// Schedule estimate smoke test (review Tasks 1, 2, 3).
//
// Verifies, WITHOUT a live phone or real Supabase:
//   T1. Business hours evaluate in an explicit IANA timezone (Asia/
//       Kolkata by default) even when the process runs with TZ=UTC:
//        - 10:00 IST inside 09:30–18:30, 20:00 IST outside
//        - Sunday in IST is excluded even inside the window
//        - msUntilBusinessHours gives the right wait across midnight
//       The old local-time (UTC) checks would flip the verdicts, so
//       this test FAILS if the timezone fix is removed.
//   T2. estimateRun uses rateLimiter's exported JITTER_EXPECTED
//       (mean of uniform [0.7, 1.4] = 1.05): 10000ms × 100 contacts →
//       1,050,000ms ±1%. FAILS on a hardcoded 0.85 → 850,000ms.
//   T3. Estimate caching:
//        - second estimateRun call does NOT re-parse (countCalls stays 1)
//        - changing schedule settings invalidates the cache
//        - user B cannot read user A's estimate (tenant scope)
//       FAILS without the hash/cache-columns logic and user_id scoping.
//
// Run: node backend/src/campaigns/__tests__/schedule-estimate-smoke.test.js
// =============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- Shared in-memory Supabase mock (injected at the client boundary)
const state = { rows: {} };

function applyRows(rows, filters) {
    let out = rows;
    for (const f of filters) {
        if (f.op === 'eq') out = out.filter(r => r[f.col] === f.val);
        else if (f.op === 'in') out = out.filter(r => f.vals.includes(r[f.col]));
    }
    return out;
}

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        rows: state.rows[name],
        select(_cols) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
                in(col, vals) { filters.push({ op: 'in', col, vals }); return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => ({ data: applyRows(state.rows[name], filters)[0] || null, error: null }),
                single: async () => ({ data: applyRows(state.rows[name], filters)[0] || null, error: null }),
                then(resolve) { return resolve({ data: applyRows(state.rows[name], filters), error: null }); },
            };
            return builder;
        },
        update(_data) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
                in(col, vals) { filters.push({ op: 'in', col, vals }); return builder; },
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

// A throwaway local file path so isRemotePath() is false and the cache
// hash picks up size+mtime (the edit-detection path under test).
const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-est-')), 'contacts.xlsx');
fs.writeFileSync(tmpFile, 'fake xlsx bytes');

const USER_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const USER_B = 'bbbbbbbb-2222-2222-2222-222222222222';

// No caps (0 disables the maxPerHour/maxPerDay branches), no business
// hours: Task 2.2 measures pure delay × contacts.
const settingsA = {
    delayBetweenMessages: 10000,
    maxPerHour: 0,
    maxPerDay: 0,
    businessHoursEnabled: false,
    countryCode: '91',
};

function seedSchedule() {
    state.rows.campaign_schedules = [
        {
            id: 'sched-A', user_id: USER_A, name: 'A run', file_path: tmpFile,
            settings: JSON.stringify(settingsA), status: 'pending',
            schedule_type: 'once', run_at: new Date(Date.now() + 3600000).toISOString(),
            next_run_at: null, buttons: '[]', allow_missing_fields: 0,
        },
    ];
    state.rows.contacts = [];
}

const schedulerService = require('../schedulerService');

// Stub _countSendableContacts: the real one needs real workbooks; here it
// stands in as the unit the cache wraps (counted so caching is observable).
let countCalls = 0;
schedulerService._countSendableContacts = async () => { countCalls += 1; return 100; };

let failures = 0;
async function run(label, fn) {
    console.log(`▶ ${label}`);
    try { await fn(); console.log(`✅ ${label} passed`); }
    catch (error) { failures++; console.error(`❌ ${label} FAILED:`, error.message); }
}

// ================================================================
async function test1_timezoneAwareBusinessHours() {
    const RateLimiter = require('../rateLimiter');
    const { zonedParts, zonedWithinBusinessHours } = RateLimiter;

    const settings = {
        businessHoursEnabled: true,
        businessHoursStart: '09:30',
        businessHoursEnd: '18:30',
        businessDays: [1, 2, 3, 4, 5, 6], // Mon-Sat
        timezone: 'Asia/Kolkata',
    };

    assert.strictEqual(zonedWithinBusinessHours(settings, new Date('2026-10-12T04:30:00Z'), 'Asia/Kolkata'), true, '10:00 IST must be inside');
    assert.strictEqual(zonedWithinBusinessHours(settings, new Date('2026-10-12T14:30:00Z'), 'Asia/Kolkata'), false, '20:00 IST must be outside');

    // Weekday difference IST vs UTC: a full-day window makes the weekday the
    // only deciding factor, isolating the timezone conversion.
    const straddle = { ...settings, businessHoursStart: '00:00', businessHoursEnd: '23:59' };
    // UTC Sunday 20:30 = IST Monday 02:00 → business day per IST → inside.
    assert.strictEqual(zonedWithinBusinessHours(straddle, new Date('2026-10-11T20:30:00Z'), 'Asia/Kolkata'), true, 'IST-Monday (UTC-Sunday) must follow the IST weekday');
    // UTC Sunday 15:00 = IST Sunday 20:30 → Sunday per IST → excluded even inside the window.
    assert.strictEqual(zonedWithinBusinessHours(straddle, new Date('2026-10-11T15:00:00Z'), 'Asia/Kolkata'), false, 'IST Sunday must be excluded even inside hours');

    assert.deepStrictEqual(zonedParts(new Date('2026-10-12T04:30:00Z'), 'Asia/Kolkata'), { hour: 10, minute: 0, weekday: 1 });

    // msUntilBusinessHours evaluated in the configured timezone, correct
    // wait across midnight (20:00 IST Mon → 09:30 IST Tue = 13.5h) and
    // from a Sunday evening (Sun 20:00 IST → Mon 09:30 IST = 13.5h).
    const rl = new RateLimiter(settings);
    assert.strictEqual(rl.msUntilBusinessHours(new Date('2026-10-12T14:30:00Z')), 13.5 * 3600000, 'wait across midnight (Mon 20:00 IST)');
    assert.strictEqual(rl.msUntilBusinessHours(new Date('2026-10-11T14:30:00Z')), 13.5 * 3600000, 'wait across midnight (Sun 20:00 IST)');
}

// ================================================================
async function test2_expectedJitterInEstimator() {
    seedSchedule();
    countCalls = 0;
    const { JITTER_EXPECTED } = require('../rateLimiter');
    assert.ok(Math.abs(JITTER_EXPECTED - 1.05) < 1e-9, 'JITTER_EXPECTED must be 1.05');

    const estimate = await schedulerService.estimateRun('sched-A', USER_A);
    const expected = 100 * 10000 * 1.05; // 1,050,000ms
    assert.ok(Math.abs(estimate.durationMs - expected) / expected < 0.01,
        `duration ${estimate.durationMs} must equal ${expected} ±1%; a hardcoded 0.85 jitter would give 850,000`);
}

// ================================================================
async function test3_businessHoursDoNotDelayCampaigns() {
    const durationMs = schedulerService._computeDurationMs({
        delayBetweenMessages: 10000,
        maxPerHour: 0,
        maxPerDay: 0,
        businessHoursEnabled: true,
        businessHoursStart: '09:30',
        businessHoursEnd: '18:30',
    }, 100);
    assert.strictEqual(durationMs, 100 * 10000 * 1.05,
        'campaign duration must not expand to fit business-hour windows');
}

// ================================================================
async function test4_estimateCache() {
    // 3.1 second call does NOT re-parse (countCalls stays 1)
    seedSchedule();
    countCalls = 0;
    await schedulerService.estimateRun('sched-A', USER_A);
    assert.strictEqual(countCalls, 1, `first call must compute once; got ${countCalls}`);
    await schedulerService.estimateRun('sched-A', USER_A);
    assert.strictEqual(countCalls, 1, `second call must reuse the cache; got ${countCalls}`);

    // 3.2 settings change invalidates the cache → exactly one recompute
    const row = state.rows.campaign_schedules.find(r => r.id === 'sched-A');
    const hashBefore = row.estimate_source_hash;
    row.settings = JSON.stringify({ ...settingsA, delayBetweenMessages: 5000 });
    countCalls = 0;
    await schedulerService.estimateRun('sched-A', USER_A);
    assert.notStrictEqual(state.rows.campaign_schedules.find(r => r.id === 'sched-A').estimate_source_hash, hashBefore,
        'settings change must invalidate the estimate cache');
    assert.strictEqual(countCalls, 1, `changed settings must trigger exactly one recompute; got ${countCalls}`);

    // 3.3 tenant isolation: user B cannot read user A's estimate
    seedSchedule();
    countCalls = 0;
    await schedulerService.estimateRun('sched-A', USER_A); // ensure cached
    const afterCache = countCalls;
    assert.ok(afterCache >= 1, 'cache must be populated for USER_A first');
    countCalls = 0;
    const cross = await schedulerService.estimateRun('sched-A', USER_B);
    assert.strictEqual(cross, null, 'user B must not read user A\'s schedule estimate');
    assert.strictEqual(countCalls, 0, `user B's must NOT trigger any recompute of user A's contacts; got ${countCalls}`);
}

(async () => {
    await run('T1: business hours respect the configured IANA timezone (TZ=UTC process)', test1_timezoneAwareBusinessHours);
    await run('T2: estimator uses rateLimiter JITTER_EXPECTED (1.05), not a hardcoded 0.85', test2_expectedJitterInEstimator);
    await run('T3: campaigns are not delayed by business hours', test3_businessHoursDoNotDelayCampaigns);
    await run('T4: estimate cache reuse, invalidation on settings change, tenant isolation', test4_estimateCache);

    if (failures) {
        console.error(`\n${failures} test(s) FAILED`);
        process.exit(1);
    }
    console.log('\n🎉 ALL SCHEDULE-ESTIMATE SMOKE TESTS PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
