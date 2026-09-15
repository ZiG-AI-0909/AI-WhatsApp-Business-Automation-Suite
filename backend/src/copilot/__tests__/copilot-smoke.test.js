// =============================================================
// Smoke test — Salesperson Copilot.
//
// Proves, WITHOUT real Supabase or a real AI call:
//   1. The brief only draws from data that exists (contact fields,
//      notes/tags, WhatsApp messages) and labels chat-derived product
//      mentions as chat mentions — never as quotations/deals.
//   2. The deterministic brief works with NO AI key configured.
//   3. Message-derived sections are correct: products discussed,
//      sizes mentioned, open customer questions, waiting-on flags.
//   4. Talking points reference real tags/notes, not invented data.
//   5. Tenant isolation: another user's contact/conversation is
//      invisible (null context), and cross-tenant message leakage
//      cannot occur.
//   6. With an AI key configured, narration is called with grounded
//      facts and the no-invention instruction.
//
// Run: node backend/src/copilot/__tests__/copilot-smoke.test.js
// =============================================================
const assert = require('assert');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const state = {
    rows: {
        contacts: [
            {
                id: 1, user_id: USER_A, phone: '919812345678', name: 'Ramesh Patel',
                company: 'Patel Hardware', city: 'Pune', email: 'ramesh@example.com',
                tags: JSON.stringify(['dealer', 'hot lead']), notes: 'Prefers evening calls. Asked about bulk discounts last time.',
                marketing_opt_in: 1, last_message_at: '2026-09-14T10:00:00Z',
            },
            // User B has their own distinct contact.
            {
                id: 2, user_id: USER_B, phone: '919700000001', name: 'Other Tenant Person',
                company: 'B Co', city: 'Mumbai', email: null, tags: '[]', notes: '',
                marketing_opt_in: 1, last_message_at: null,
            },
        ],
        conversations: [
            { id: 10, user_id: USER_A, contact_id: 1, status: 'open', ai_enabled: 1, last_message_at: '2026-09-14T10:00:00Z', unread_count: 1 },
            { id: 11, user_id: USER_B, contact_id: 2, status: 'open', ai_enabled: 1, last_message_at: '2026-09-14T10:00:00Z', unread_count: 0 },
        ],
        messages: [
            { conversation_id: 10, user_id: USER_A, direction: 'inbound', body: 'Hi, do you have HDPE pipe 110mm in stock? What is the price for 500 meters?', status: 'received', created_at: '2026-09-13T09:00:00Z' },
            { conversation_id: 10, user_id: USER_A, direction: 'outbound', body: 'Hello! Yes, HDPE 110mm PE100 is available. Our sales team will share the rate list shortly.', status: 'sent', created_at: '2026-09-13T09:05:00Z' },
            { conversation_id: 10, user_id: USER_A, direction: 'inbound', body: 'Please share the price and delivery time for Pune.', status: 'received', created_at: '2026-09-14T10:00:00Z' },
            // User B's own messages on their own conversation.
            { conversation_id: 11, user_id: USER_B, direction: 'inbound', body: 'CPVC fittings catalogue please?', status: 'received', created_at: '2026-09-14T11:00:00Z' },
        ],
        app_settings: [],
    },
};

function table(name) {
    return {
        select(columns, { columns: _c } = {}) {
            const builder = {
                eq(col, val) { builder._filters.push([col, val]); return builder; },
                in(col, vals) { builder._in = [col, vals]; return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                _filters: [],
                _in: null,
                async then(resolve) {
                    let rows = state.rows[name] || [];
                    for (const [col, val] of builder._filters) rows = rows.filter((r) => r[col] === val);
                    if (builder._in) {
                        const [col, vals] = builder._in;
                        rows = rows.filter((r) => vals.includes(r[col]));
                    }
                    resolve({ data: rows.map((r) => ({ ...r })), error: null });
                },
            };
            builder.single = async () => {
                let rows = state.rows[name] || [];
                for (const [col, val] of builder._filters) rows = rows.filter((r) => r[col] === val);
                const row = rows[0] || null;
                return { data: row ? { ...row } : null, error: row ? null : { code: 'PGRST116' } };
            };
            return builder;
        },
        insert(row) {
            return {
                select() {
                    return {
                        single: async () => {
                            const stored = { ...row, id: (state.rows[name].length + 1) };
                            state.rows[name].push(stored);
                            return { data: stored, error: null };
                        },
                    };
                },
            };
        },
        update() {
            const builder = { eq() { return builder; }, select: async () => ({ data: [], error: null }) };
            return builder;
        },
    };
}

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
// Deliberately NO AI key: tests 1-4 must pass without one. The real .env
// (loaded by aiService's dotenv) may define AI_API_KEY — remove it so the
// deterministic path is what's under test. Test 5 sets its own key.
delete process.env.AI_API_KEY;
delete process.env.AI_BASE_URL;

const copilotService = require('../copilotService');

// Safety net: never let a test reach the real AI provider. narrate() catches
// this and returns null (its documented fallback); test 5 swaps in a capture.
const realAiService = require('../../ai/aiService');
realAiService._complete = async () => {
    throw new Error('AI calls are stubbed in this test');
};

async function test1_deterministicBriefWithoutAiKey() {
    console.log('▶ Test 1: brief works with no AI key (deterministic only)');
    const brief = await copilotService.brief(USER_A, { contactId: 1, narrative: true });
    assert.ok(brief, 'brief returned');
    assert.strictEqual(brief.ai_summary_available, false, 'no AI narration without a key');
    assert.ok(brief.ai_summary === null, 'ai_summary null');
    assert.ok(brief.conversation_summary.includes('3 messages'), 'deterministic summary counts messages');
    assert.deepStrictEqual(brief.data_sources, ['contact fields', 'contact notes/tags', 'WhatsApp conversation history'], 'data sources listed honestly');
    console.log('✅ Test 1 passed\n');
}

async function test2_briefContentGrounded() {
    console.log('▶ Test 2: brief content matches the actual data');
    const brief = await copilotService.brief(USER_A, { contactId: 1, narrative: false });
    assert.strictEqual(brief.contact.name, 'Ramesh Patel');
    assert.deepStrictEqual(brief.contact.tags, ['dealer', 'hot lead'], 'tags parsed');
    assert.ok(brief.contact.notes.includes('evening calls'), 'notes surfaced');

    assert.strictEqual(brief.conversation_stats.total_messages, 3, 'only this contact messages counted');
    assert.strictEqual(brief.conversation_stats.inbound, 2);
    assert.strictEqual(brief.conversation_stats.outbound, 1);
    assert.strictEqual(brief.conversation_stats.waiting_on_customer, false, 'last message is inbound — waiting on us');
    assert.strictEqual(brief.conversation_stats.last_direction, 'inbound');

    // Product mentions come from chat text and are labelled as chat mentions.
    assert.ok(brief.products_discussed_from_chat.some((p) => p.startsWith('hdpe')), 'HDPE mentioned in chat detected');
    assert.ok(brief.sizes_mentioned_in_chat.some((s) => s.includes('110')), '110mm size mentioned in chat detected');

    // Open questions: customer's question-like messages.
    assert.ok(brief.open_questions_from_customer.some((q) => /price for 500 meters/.test(q)), 'price question captured');
    assert.ok(brief.open_questions_from_customer.some((q) => /delivery time for Pune/.test(q)), 'delivery question captured');

    // Talking points reference real data, never fabricated quotations.
    assert.ok(brief.suggested_talking_points.some((p) => /outstanding questions/i.test(p)), 'points prioritize open questions');
    assert.ok(brief.suggested_talking_points.some((p) => p.includes('dealer') || p.includes('hot lead')), 'points use real tags');
    assert.ok(brief.suggested_talking_points.some((p) => p.includes('Patel Hardware')), 'points use real company');
    assert.ok(brief.suggested_talking_points.some((p) => /Re-read the contact notes/.test(p)), 'points point to real notes');

    // HONESTY: the words "quotation" must not appear as a data source for
    // products; only chat mentions exist.
    const briefJson = JSON.stringify(brief);
    assert.ok(!briefJson.includes('"quotations"'), 'no fabricated quotations field');
    assert.ok(briefJson.includes('products_discussed_from_chat'), 'product data explicitly labelled chat-derived');
    console.log('✅ Test 2 passed\n');
}

async function test3_waitingOnCustomerFlag() {
    console.log('▶ Test 3: waiting-on-customer flag flips with last direction');
    state.rows.messages.find((m) => m.conversation_id === 10 && m.direction === 'inbound' && m.body.includes('delivery')).direction = 'outbound';
    const brief = await copilotService.brief(USER_A, { contactId: 1, narrative: false });
    assert.strictEqual(brief.conversation_stats.waiting_on_customer, true, 'outbound last → waiting on customer');
    // With open customer questions still present, answering them takes
    // priority over a generic follow-up nudge (intended service behavior).
    assert.ok(brief.suggested_talking_points.some((p) => /outstanding questions/i.test(p)), 'open questions still take priority');
    state.rows.messages.find((m) => m.conversation_id === 10 && m.direction === 'outbound' && m.body.includes('delivery')).direction = 'inbound';

    // No open questions + last message outbound → follow-up point appears.
    const saved = state.rows.messages.filter((m) => m.conversation_id === 10);
    state.rows.messages = state.rows.messages.filter((m) => m.conversation_id !== 10).concat([
        { conversation_id: 10, user_id: USER_A, direction: 'inbound', body: 'Thanks, got it.', status: 'received', created_at: '2026-09-14T09:00:00Z' },
        { conversation_id: 10, user_id: USER_A, direction: 'outbound', body: 'Sent you the rate list.', status: 'sent', created_at: '2026-09-14T10:00:00Z' },
    ]);
    const brief2 = await copilotService.brief(USER_A, { contactId: 1, narrative: false });
    assert.strictEqual(brief2.conversation_stats.waiting_on_customer, true, 'outbound last → waiting on customer');
    assert.ok(brief2.suggested_talking_points.some((p) => /follow up politely/i.test(p)), 'follow-up point appears when nothing is open');
    state.rows.messages = state.rows.messages.filter((m) => m.conversation_id !== 10).concat(saved);
    console.log('✅ Test 3 passed\n');
}

async function test4_tenantIsolation() {
    console.log('▶ Test 4: cross-tenant briefs are impossible');
    // User B asking for user A's contact id gets null (404 at the route).
    const leaked = await copilotService.brief(USER_B, { contactId: 1, narrative: false });
    assert.strictEqual(leaked, null, 'user B cannot read user A contact brief');

    // User B's own brief contains only their own data.
    const own = await copilotService.brief(USER_B, { contactId: 2, narrative: false });
    assert.ok(own, 'user B gets their own brief');
    assert.strictEqual(own.contact.name, 'Other Tenant Person', 'own contact returned');
    assert.ok(own.products_discussed_from_chat.some((p) => p.startsWith('cpvc')), 'own chat mentions found');
    assert.ok(!JSON.stringify(own).includes('Ramesh'), 'user A data never appears in user B brief');
    assert.ok(!JSON.stringify(own).includes('hdpe'), 'user A chat content never appears in user B brief');

    // Conversation-id path: same isolation.
    const convLeak = await copilotService.brief(USER_A, { conversationId: 11, narrative: false });
    assert.strictEqual(convLeak, null, 'user A cannot read user B conversation brief');
    const convOwn = await copilotService.brief(USER_A, { conversationId: 10, narrative: false });
    assert.strictEqual(convOwn.contact.id, 1, 'own conversation brief works');
    console.log('✅ Test 4 passed\n');
}

async function test5_narrationPromptGrounding() {
    console.log('▶ Test 5: AI narration receives grounded facts + no-invention rules');
    process.env.AI_API_KEY = 'env-test-key';
    let captured = null;
    realAiService._complete = async (messages, options) => {
        captured = { messages, options };
        return 'Brief: customer asked about HDPE 110mm in chat; confirm price next.';
    };
    const brief = await copilotService.brief(USER_A, { contactId: 1, narrative: true });
    assert.strictEqual(brief.ai_summary_available, true, 'narration present with key');
    assert.ok(brief.ai_summary.includes('HDPE'), 'narrative returned');
    assert.ok(captured, 'AI was called');
    assert.ok(captured.messages[0].content.includes('do not invent quotations'), 'no-invention instruction in prompt');
    assert.ok(captured.messages[0].content.includes('products_mentioned_in_chat'), 'chat-mention labelling in prompt');
    assert.ok(captured.messages[0].content.includes('Ramesh Patel'), 'real contact data in prompt');
    delete process.env.AI_API_KEY;
    console.log('✅ Test 5 passed\n');
}

async function main() {
    try {
        await test1_deterministicBriefWithoutAiKey();
        await test2_briefContentGrounded();
        await test3_waitingOnCustomerFlag();
        await test4_tenantIsolation();
        await test5_narrationPromptGrounding();
        console.log('🎉 ALL COPILOT SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
