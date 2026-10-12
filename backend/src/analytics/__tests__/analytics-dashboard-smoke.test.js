// =============================================================
// Smoke test — Analytics dashboard performance (2026-09 fix).
//
// The Dashboard view polls GET /analytics/dashboard every 10s. The
// pre-fix implementation fired 14 PostgREST round trips per poll
// (11 exact counts + 3 sequential selects) and exceeded the client's
// 30s budget on a large messages table.
//
// Proves, WITHOUT real Supabase:
//   1. FAST PATH: the single-RPC aggregation (get_dashboard_metrics)
//      produces the exact same payload shape the frontend expects, and
//      issues 3 calls total (1 rpc + 2 parallel selects), not 14.
//   2. CACHE: two getDashboard calls within the TTL hit the DB only
//      once — and invalidateDashboardCache() busts it.
//   3. FALLBACK: when the RPC is missing (PGRST202, pre-migration
//      state) it silently falls back to the original 14-call path and
//      produces the identical payload.
//   4. Honest warning (not silent swallow) on non-PGRST202 rpc errors.
//
// Run: node backend/src/analytics/__tests__/analytics-dashboard-smoke.test.js
// =============================================================
const assert = require('assert');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_C = '33333333-3333-3333-3333-333333333333';
const USER_D = '44444444-4444-4444-4444-444444444444';

// ── Expected metric payload (parity between fast path and legacy path) ──
const EXPECTED = {
    contacts: { total: 120, optedOut: 5, active: 115 },
    conversations: { total: 40, open: 12, resolved: 25, human_takeover: 3 },
    messages: { total: 5400, inbound: 2600, outbound: 2800 },
    campaigns: {
        total: 7, active: 2,
        total_sent: 4000, total_failed: 120, total_replies: 350, total_opt_outs: 18,
    },
};

// ── The exact rpc row the migration's json_build_object produces ──
const RPC_ROW = {
    total_contacts: 120, opted_out: 5,
    total_conversations: 40, conversations_open: 12,
    conversations_takeover: 3, conversations_resolved: 25,
    total_messages: 5400, messages_inbound: 2600, messages_outbound: 2800,
    total_campaigns: 7, campaigns_running: 2,
    campaigns_sent: 4000, campaigns_failed: 120, campaigns_replies: 350, campaigns_opt_outs: 18,
};

// ── Mock Supabase, injected BEFORE any module loads ──
let rpcCalls = 0;
let rpcResult = { data: RPC_ROW, error: null };
let selectCalls = 0;

// Counts per table/filter, mirroring the legacy path's db.count() filters.
// db.count() resolves { count, error } (PostgREST head:true + count:'exact'),
// so the mock's then() must provide `count` too.
const COUNTS = {
    contacts: (f) => ('marketing_opt_in' in f ? 5 : 120),
    conversations: (f) => (f.status === 'open' ? 12 : f.status === 'resolved' ? 25 : f.status === 'human_takeover' ? 3 : 40),
    messages: (f) => (f.direction === 'inbound' ? 2600 : f.direction === 'outbound' ? 2800 : 5400),
    campaigns: (f) => (f.status === 'running' ? 2 : 7),
};

function makeBuilder(table) {
    const filters = {};
    const builder = {
        select() {
            selectCalls++;
            return builder;
        },
        eq(col, val) { filters[col] = val; return builder; },
        order() { return builder; },
        limit() { return builder; },
        range() { return builder; },
        async then(resolve) {
            const count = COUNTS[table] ? COUNTS[table](filters) : 0;
            const data = table === 'campaigns'
                ? [
                    { sent: '1000', failed: '40', replies: '100', opt_outs: '5' },
                    { sent: '3000', failed: '80', replies: '250', opt_outs: '13' },
                ]
                : [
                    { body: 'hello', direction: 'inbound', created_at: '2026-09-21T10:00:00Z',
                        conversations: { contacts: { phone: '+911234567890', name: 'Test', is_lid: 0 } } },
                    { body: 'hi', direction: 'outbound', created_at: '2026-09-21T10:01:00Z',
                        conversations: { contacts: { phone: '+911234567890', name: 'Test', is_lid: 0 } } },
                ];
            resolve({ data, count, error: null });
        },
        single: async () => ({ data: null, error: { code: 'PGRST116' } }),
    };
    return builder;
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true,
    exports: {
        supabase: {
            from: (table) => makeBuilder(table),
            async rpc(fn, params) {
                rpcCalls++;
                assert.strictEqual(fn, 'get_dashboard_metrics', 'rpc function name');
                assert.ok(/^[0-9a-f-]{36}$/i.test(params.p_user_id), 'rpc receives a tenant id');
                return rpcResult; // { data, error } — the service must handle error, never throw
            },
        },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const analyticsService = require('../analyticsService');

function assertDashboardShape(result, label) {
    assert.deepStrictEqual(result.contacts, EXPECTED.contacts, `${label}: contacts metrics`);
    assert.deepStrictEqual(result.conversations, EXPECTED.conversations, `${label}: conversation metrics`);
    assert.deepStrictEqual(result.messages, EXPECTED.messages, `${label}: message metrics`);
    assert.deepStrictEqual(result.campaigns, EXPECTED.campaigns, `${label}: campaign metrics (client-side sums)`);
    assert.strictEqual(result.recentCampaigns.length, 2, `${label}: recent campaigns carried`);
    assert.strictEqual(result.recentMessages.length, 2, `${label}: recent messages carried`);
    assert.strictEqual(result.recentMessages[0].phone, '+911234567890', `${label}: embedded contact flattened`);
    assert.strictEqual(result.recentMessages[0].is_lid, 0, `${label}: is_lid flattened`);
}

async function test1_fastPathParity() {
    console.log('▶ Test 1: single-RPC fast path produces the exact frontend payload (3 calls, not 14)');
    const result = await analyticsService.getDashboard(USER_A);

    assertDashboardShape(result, 'fast path');
    assert.strictEqual(rpcCalls, 1, 'exactly one rpc call');
    assert.strictEqual(selectCalls, 2, 'exactly two selects (Promise.all), not 3 sequential');
    console.log('✅ Test 1 passed (1 rpc + 2 selects, payload parity proven)\n');
}

async function test2_cache() {
    console.log('▶ Test 2: 30s TTL cache — second poll hits zero DB calls; invalidation works');
    // Test 1 already populated the cache for USER_A.
    const before = { rpc: rpcCalls, sel: selectCalls };
    const again = await analyticsService.getDashboard(USER_A);
    assert.strictEqual(rpcCalls, before.rpc, 'no rpc on cached call');
    assert.strictEqual(selectCalls, before.sel, 'no selects on cached call');
    assert.deepStrictEqual(again.contacts, EXPECTED.contacts, 'cached payload identical');

    analyticsService.invalidateDashboardCache(USER_A);
    await analyticsService.getDashboard(USER_A);
    assert.strictEqual(rpcCalls, before.rpc + 1, 'cache busted → one more rpc');
    console.log('✅ Test 2 passed\n');
}

async function test3_pgrst202_fallback() {
    console.log('▶ Test 3: PGRST202 (function missing) → silent fallback, legacy path, same payload');
    // Fresh user avoids the cache from tests 1-2.
    rpcResult = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_dashboard_metrics' } };

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); return origWarn(...args); };
    let result;
    try {
        result = await analyticsService.getDashboard(USER_C);
    } finally {
        console.warn = origWarn;
    }
    assert.strictEqual(warnings.length, 0, 'PGRST202 stays silent (expected pre-migration state)');
    assertDashboardShape(result, 'legacy fallback');
    console.log('✅ Test 3 passed (legacy fallback payload parity, no noise)\n');
}

async function test4_realRpcErrorWarns() {
    console.log('▶ Test 4: non-PGRST202 rpc error warns honestly, still falls back');
    rpcResult = { data: null, error: { code: '42501', message: 'permission denied for table contacts' } };

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); return origWarn(...args); };
    let result;
    try {
        result = await analyticsService.getDashboard(USER_D);
    } finally {
        console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => w.includes('[analytics]') && w.includes('42501')), 'honest warning with error code');
    assertDashboardShape(result, 'error fallback');
    console.log('✅ Test 4 passed (honest warning + fallback)\n');
}

async function main() {
    try {
        await test1_fastPathParity();
        await test2_cache();
        await test3_pgrst202_fallback();
        await test4_realRpcErrorWarns();
        console.log('🎉 ALL ANALYTICS DASHBOARD SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
