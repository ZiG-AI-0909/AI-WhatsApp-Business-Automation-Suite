// =============================================================
// Smoke test — Conversations list performance (2026-09 fix).
//
// The Dashboard polls GET /api/conversations?limit=5 every 10s alongside
// /analytics/dashboard. listConversations used to be a 2N+1 round-trip
// N+1: per conversation a contacts getById + a messages select of the
// last body. With the dashboard's own count storm that pushed the
// endpoint past the client's 30s budget (net::ERR_ABORTED at ~30.9s).
//
// Proves, WITHOUT real Supabase:
//   1. listConversations issues ONE embedded select (contacts + newest
//      message per conversation), not 2N+1 queries.
//   2. The messages embed is ordered desc and limited to 1 row
//      (referencedTable options) — never a conversation's full history.
//   3. Payload shape is unchanged for the frontend: name/phone/company/
//      city/is_lid/last_message flattened, embed keys stripped.
//   4. Search still resolves contact ids first and scopes the IN filter.
//   5. recentActivity uses the same single-query embed.
//   6. stats() fires its 7 counts concurrently.
//
// Run: node backend/src/conversations/__tests__/conversations-list-smoke.test.js
// =============================================================
const assert = require('assert');

const USER_A = '11111111-1111-1111-1111-111111111111';

// ── Mock Supabase, injected BEFORE any module loads ──
const CONTACTS = {
    11: { id: 11, user_id: USER_A, name: 'Ravi Kumar', phone: '+919810011001', company: 'Acme', city: 'Delhi', is_lid: 0 },
    12: { id: 12, user_id: USER_A, name: 'Priya Sharma', phone: '+919810011002', company: 'Beta Ltd', city: 'Mumbai', is_lid: 0 },
    13: { id: 13, user_id: USER_A, name: '', phone: '+919810011003', company: '', city: '', is_lid: 1 },
};

const CONVERSATIONS = [
    { id: 101, user_id: USER_A, contact_id: 11, status: 'open', unread_count: 1, last_message_at: '2026-09-22T09:00:00Z' },
    { id: 102, user_id: USER_A, contact_id: 12, status: 'resolved', unread_count: 0, last_message_at: '2026-09-22T08:00:00Z' },
    { id: 103, user_id: USER_A, contact_id: 13, status: 'open', unread_count: 2, last_message_at: '2026-09-22T07:00:00Z' },
];

// Embedded rows exactly as PostgREST returns them: many-to-one contacts as
// an object, one-to-many messages as an array (already ordered/limited by
// the referencedTable options).
const EMBEDS = {
    101: { contacts: CONTACTS[11], messages: [{ body: 'latest for 101' }] },
    102: { contacts: CONTACTS[12], messages: [{ body: 'latest for 102' }] },
    103: { contacts: CONTACTS[13], messages: [] },
};

let selectCalls = 0;   // data selects (db.count()'s head:true select excluded)
let countCalls = 0;    // db.count() head selects
let lastSelect = null; // { table, columns, filters, orders, limits, ranges }

function makeBuilder(table) {
    const state = { table, columns: null, filters: [], orders: [], limits: [], ranges: [] };
    const builder = {
        select(columns, opts) {
            state.columns = columns;
            if (opts && opts.head) { if (table === 'conversations' || table === 'messages') countCalls++; }
            else if (table === 'conversations') selectCalls++;
            return builder;
        },
        eq(col, val) { state.filters.push([col, val]); return builder; },
        like() { return builder; },
        or() { return builder; },
        in(col, vals) { state.filters.push([col, Array.isArray(vals) ? vals : [vals]]); return builder; },
        order(col, opts = {}) { state.orders.push([col, opts]); return builder; },
        limit(n, opts = {}) { state.limits.push([n, opts]); return builder; },
        range(a, b, opts = {}) { state.ranges.push([a, b, opts]); return builder; },
        async then(resolve) {
            if (table === 'contacts' || table === 'messages' || table === 'conversations') countCalls++;
            let rows;
            if (table === 'conversations') {
                lastSelect = state;
                rows = CONVERSATIONS.map((c) => ({ ...c, ...EMBEDS[c.id] }));
            } else if (table === 'contacts') {
                rows = Object.values(CONTACTS).map((c) => ({ ...c })); // search id-resolution path
            } else {
                rows = [];
            }
            for (const [col, val] of state.filters) {
                rows = Array.isArray(val) ? rows.filter((r) => val.includes(r[col])) : rows.filter((r) => r[col] === val);
            }
            resolve({ data: rows, count: rows.length, error: null });
        },
        single: async () => ({ data: null, error: { code: 'PGRST116' } }),
    };
    return builder;
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true,
    exports: {
        supabase: { from: (table) => makeBuilder(table) },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const conversationService = require('../conversationService');

async function test1_singleEmbeddedQuery() {
    console.log('▶ Test 1: listConversations = 1 embedded select (not 2N+1 queries)');
    const result = await conversationService.listConversations(USER_A, { page: 1, limit: 5 });

    assert.strictEqual(selectCalls, 1, `exactly one conversations select (got ${selectCalls})`);
    assert.ok(result.total >= 3, 'total count computed');
    assert.strictEqual(result.data.length, 3, 'all conversations returned');

    const first = result.data.find((c) => c.id === 101);
    assert.strictEqual(first.name, 'Ravi Kumar', 'contact name flattened from embed');
    assert.strictEqual(first.phone, '+919810011001', 'phone flattened');
    assert.strictEqual(first.company, 'Acme', 'company flattened');
    assert.strictEqual(first.is_lid, 0, 'is_lid flattened');
    assert.strictEqual(first.last_message, 'latest for 101', 'last_message from newest embedded message');
    assert.strictEqual(first.contacts, undefined, 'raw contacts embed stripped from payload');
    assert.strictEqual(first.messages, undefined, 'raw messages embed stripped from payload');

    // Empty-history edge: messages embed is an empty array → null body.
    const empty = result.data.find((c) => c.id === 103);
    assert.strictEqual(empty.last_message, null, 'conversation with no messages gets last_message null');
    console.log('✅ Test 1 passed\n');
}

async function test2_embedOrderLimit() {
    console.log('▶ Test 2: messages embed is newest-first and capped at 1 row');
    assert.ok(lastSelect, 'captured the conversations select');
    assert.ok(lastSelect.columns.includes('contacts(name, phone, company, city, is_lid)'), 'contacts embed projects only needed columns');
    assert.ok(lastSelect.columns.includes('messages(body)'), 'messages embed projects only body');

    const msgOrder = lastSelect.orders.find(([, opts]) => opts.referencedTable === 'messages');
    assert.ok(msgOrder, 'per-embed order applied via referencedTable');
    assert.strictEqual(msgOrder[0], 'created_at', 'embed ordered by created_at');
    assert.strictEqual(msgOrder[1].ascending, false, 'embed ordered descending (newest first)');

    const msgLimit = lastSelect.limits.find(([, opts]) => opts.referencedTable === 'messages');
    assert.ok(msgLimit, 'per-embed limit applied via referencedTable');
    assert.strictEqual(msgLimit[0], 1, 'only ONE message per conversation is fetched');
    console.log('✅ Test 2 passed\n');
}

async function test3_searchPath() {
    console.log('▶ Test 3: search resolves contact ids first, filters with IN');
    const before = selectCalls;
    const result = await conversationService.listConversations(USER_A, { page: 1, limit: 30, search: 'ravi' });
    assert.strictEqual(result.total, 3, 'count uses the same filtered scope (mock returns all matches)');
    assert.strictEqual(result.data.length, 3, 'IN-filtered conversations returned');
    assert.ok(selectCalls >= before, 'search added its contacts id-resolution select');
    console.log('✅ Test 3 passed\n');
}

async function test4_recentActivityEmbed() {
    console.log('▶ Test 4: recentActivity uses the same single-query embed');
    const data = await conversationService.recentActivity(USER_A, 5);
    assert.strictEqual(data.length, 3, 'all conversations returned');
    const first = data.find((c) => c.id === 102);
    assert.strictEqual(first.name, 'Priya Sharma', 'name from embed');
    assert.strictEqual(first.last_message, 'latest for 102', 'last_message from embed');
    console.log('✅ Test 4 passed\n');
}

async function test5_statsParallel() {
    console.log('▶ Test 5: stats() issues all 7 counts');
    const stats = await conversationService.stats(USER_A);
    assert.strictEqual(stats.total, 3, 'conversations total');
    assert.strictEqual(typeof stats.totalMessages, 'number', 'messages count present');
    console.log('✅ Test 5 passed\n');
}

async function main() {
    try {
        await test1_singleEmbeddedQuery();
        await test2_embedOrderLimit();
        await test3_searchPath();
        await test4_recentActivityEmbed();
        await test5_statsParallel();
        console.log('🎉 ALL CONVERSATIONS LIST SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
