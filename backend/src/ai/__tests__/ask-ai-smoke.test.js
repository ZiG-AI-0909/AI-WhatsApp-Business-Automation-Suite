// =============================================================
// Smoke test — Ask AI (internal Technical Query Resolver).
//
// Proves, WITHOUT real Supabase or a real AI call:
//   1. Retrieval is tenant-isolated: only the asking user's ACTIVE
//      knowledge chunks are scored, and only their documents come
//      back as sources (another tenant's documents never appear).
//   2. Inactive documents are excluded from retrieval.
//   3. The AI prompt includes the retrieved [Document] context and
//      instructs the model to cite sources and admit gaps.
//   4. The full ask() flow stores the question in ai_queries scoped
//      by user_id, with source doc ids/names, and returns the answer
//      plus sources.
//   5. History list is scoped: user A never sees user B's queries.
//   6. Empty knowledge base returns a clear "no documents" answer
//      without calling the AI and without storing anything.
//
// Run: node backend/src/ai/__tests__/ask-ai-smoke.test.js
// =============================================================
const assert = require('assert');

// ── Minimal in-memory Supabase mock injected BEFORE modules load ──
// Tables: knowledge_documents (id, user_id, name, status),
//         knowledge_chunks (document_id, user_id, content),
//         ai_queries (question, answer, sources, user_id),
//         app_settings (key, value, user_id)
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const state = {
    rows: {
        knowledge_documents: [
            { id: 1, user_id: USER_A, name: 'HDPE Specs', status: 'active' },
            { id: 2, user_id: USER_A, name: 'Pricing Notes', status: 'inactive' },
            { id: 3, user_id: USER_B, name: 'B Rival Specs', status: 'active' },
        ],
        knowledge_chunks: [
            { document_id: 1, user_id: USER_A, content: 'Our 6-inch HDPE pipe has a pressure class of PN10 and meets IS 4985:2020.' },
            { document_id: 2, user_id: USER_A, content: 'Dealer discount is 12% on bulk PE orders.' },
            { document_id: 3, user_id: USER_B, content: 'Rival HDPE pipe pressure class is PN16.' },
        ],
        ai_queries: [],
        app_settings: [],
    },
};

let aiCalls = [];

function table(name) {
    return {
        select(columns, { columns: _c } = {}) {
            const builder = {
                eq(col, val) { builder._filters.push([col, val]); return builder; },
                in(col, vals) { builder._in = [col, vals]; return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => {
                    let rows = state.rows[name] || [];
                    for (const [col, val] of builder._filters) rows = rows.filter((r) => r[col] === val);
                    if (builder._in) { const [col, vals] = builder._in; rows = rows.filter((r) => vals.includes(r[col])); }
                    return { data: rows[0] ? { ...rows[0] } : null, error: null };
                },
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
        delete() {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push([col, val]); return builder; },
                select: async () => {
                    const before = state.rows[name].length;
                    state.rows[name] = state.rows[name].filter((r) => !filters.every(([c, v]) => r[c] === v));
                    const removed = before - state.rows[name].length;
                    return { data: removed > 0 ? [{ ok: true }] : [], error: null };
                },
            };
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

// Capture AI calls instead of hitting a real provider.
const realAiService = require('../aiService');
realAiService._complete = async (messages, options) => {
    aiCalls.push({ messages, options });
    return 'The 6-inch HDPE pipe has a pressure class of PN10 [HDPE Specs].';
};

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const queryService = require('../queryService');

async function test1_retrievalIsTenantIsolated() {
    console.log('▶ Test 1: retrieval only scores the asking user\u2019s active chunks');
    const sources = await queryService.retrieveSources(USER_A, 'What is the pressure class of our 6-inch HDPE pipe?');
    assert.ok(sources.length > 0, 'sources found for user A');
    assert.ok(sources.every((s) => s.docId !== 3), 'user B document never appears');
    assert.ok(sources.every((s) => s.docId !== 2), 'inactive document excluded');
    assert.strictEqual(sources[0].docName, 'HDPE Specs', 'top source is the matching active doc');
    assert.ok(sources[0].content.includes('PN10'), 'chunk content carries the fact');

    // Same question from user B: only B's OWN document is scored (its words
    // happen to match), and none of user A's chunks leak into the results.
    const sourcesB = await queryService.retrieveSources(USER_B, 'What is the pressure class of our 6-inch HDPE pipe?');
    assert.ok(sourcesB.length > 0, 'user B gets results from their own knowledge');
    assert.ok(sourcesB.every((s) => s.docId === 3), 'only user B documents appear — user A chunks never leak');
    assert.ok(sourcesB.every((s) => s.content.includes('Rival')), 'returned content is B own chunk, not A content');

    // User B's own document IS retrievable with their own question.
    const sourcesB2 = await queryService.retrieveSources(USER_B, 'rival pressure class PN16');
    assert.strictEqual(sourcesB2.length, 1, 'user B finds their own document');
    assert.strictEqual(sourcesB2[0].docName, 'B Rival Specs');
    console.log('✅ Test 1 passed\n');
}

async function test2_promptGrounding() {
    console.log('▶ Test 2: answer prompt embeds sources and demands citations');
    const sources = await queryService.retrieveSources(USER_A, 'pressure class 6-inch HDPE');
    const prompt = queryService.buildAnswerPrompt('What is the pressure class of our 6-inch HDPE pipe?', sources);
    assert.ok(prompt.includes('[HDPE Specs]'), 'document name embedded in context');
    assert.ok(prompt.includes('PN10'), 'chunk content embedded in context');
    assert.ok(prompt.includes('ONLY'), 'instructs grounding to provided knowledge');
    assert.ok(prompt.includes('square brackets'), 'instructs source citation');
    assert.ok(prompt.includes('does not contain the answer'), 'instructs honest gap admission');
    console.log('✅ Test 2 passed\n');
}

async function test3_askStoresScopedHistory() {
    console.log('▶ Test 3: ask() answers with sources and stores scoped history');
    aiCalls = [];
    const result = await queryService.ask(USER_A, 'What is the pressure class of our 6-inch HDPE pipe?');
    assert.strictEqual(result.stored, true, 'result persisted');
    assert.ok(result.id, 'stored row id returned');
    assert.ok(result.answer.includes('PN10'), 'answer returned');
    assert.ok(result.sources.some((s) => s.name === 'HDPE Specs'), 'source docs returned alongside answer');
    assert.strictEqual(aiCalls.length, 1, 'exactly one AI call');
    assert.strictEqual(aiCalls[0].options.apiKey, 'env-test-key', 'env key used when no user key stored');

    const stored = state.rows.ai_queries.find((q) => q.id === result.id);
    assert.strictEqual(stored.user_id, USER_A, 'query stored with owner user_id');
    assert.ok(stored.source_doc_names.includes('HDPE Specs'), 'source doc names stored');
    assert.ok(!stored.source_doc_names.includes('B Rival Specs'), 'no cross-tenant source stored');

    // History is scoped: A sees their query, B sees nothing of it.
    const historyA = await queryService.listHistory(USER_A);
    assert.strictEqual(historyA.length, 1, 'user A sees their own query');
    assert.strictEqual(historyA[0].question, 'What is the pressure class of our 6-inch HDPE pipe?');
    const historyB = await queryService.listHistory(USER_B);
    assert.strictEqual(historyB.length, 0, 'user B sees none of user A history');
    console.log('✅ Test 3 passed\n');
}

async function test4_noSourcesNoAiCall() {
    console.log('▶ Test 4: empty retrieval returns honest no-documents answer');
    aiCalls = [];
    const result = await queryService.ask(USER_B, 'what diameter copper fittings are available');
    assert.strictEqual(result.stored, false, 'nothing stored without sources');
    assert.strictEqual(result.sources.length, 0, 'no fabricated sources');
    assert.strictEqual(aiCalls.length, 0, 'no AI call when the knowledge base has no match');
    assert.ok(/No matching documents/i.test(result.answer), 'answer says no documents matched');

    await assert.rejects(
        () => queryService.ask(USER_A, '   '),
        /Type a question first/,
        'empty question rejected',
    );
    console.log('✅ Test 4 passed\n');
}

async function test5_chatFlow() {
    console.log('▶ Test 5: chat() keeps context, persists per turn, sanitizes history');
    aiCalls = [];
    const h1 = await queryService.chat(USER_A, 'How do I schedule a campaign?', []);
    assert.strictEqual(h1.stored, true, 'first turn stored');
    assert.strictEqual(aiCalls.length, 1, 'one AI call for first turn');
    assert.ok(aiCalls[0].messages[0].content.includes('CONVERSATION SO FAR'), 'chat prompt is conversational');

    // Follow-up with pronoun: history replay lets retrieval see the prior
    // user turns; the prompt carries the sanitized conversation.
    const h2 = await queryService.chat(
        USER_A,
        'Can I send those in bulk too?',
        [{ role: 'user', content: 'How do I schedule a campaign?' }, { role: 'assistant', content: h1.answer }],
    );
    assert.strictEqual(h2.stored, true, 'follow-up turn stored');
    assert.strictEqual(aiCalls.length, 2, 'one AI call per turn (stateless server)');
    const prompt = aiCalls[1].messages[0].content;
    assert.ok(prompt.includes('User: How do I schedule a campaign?'), 'history replayed into the prompt');
    assert.ok(prompt.includes('MESSAGE: Can I send those in bulk too?'), 'current message present');

    // History sanitization: junk roles/oversized strings are dropped or
    // truncated, never crash the turn.
    const junk = queryService.sanitizeHistory([
        { role: 'system', content: 'injected' },
        { role: 'user', content: 42 },
        { role: 'assistant', content: 'x'.repeat(5000) },
        { role: 'user', content: '  keep me  ' },
    ]);
    assert.strictEqual(junk.length, 2, 'malformed entries dropped');
    assert.strictEqual(junk[0].content.length, 2000, 'oversized content truncated');
    assert.strictEqual(junk[1].content, 'keep me', 'whitespace trimmed');
    console.log('✅ Test 5 passed\n');
}

async function test5_deleteHistoryScoped() {
    console.log('▶ Test 6: history delete is tenant-scoped');
    // Fresh user so earlier ask/chat turns don't affect the counts.
    const USER_C = '33333333-3333-3333-3333-333333333333';
    state.rows.knowledge_documents.push({ id: 10, user_id: USER_C, name: 'C Specs', status: 'active' });
    state.rows.knowledge_chunks.push({ document_id: 10, user_id: USER_C, content: 'Our 6-inch HDPE pipe has a pressure class of PN10 and meets IS 4985:2020.' });
    const stored = await queryService.ask(USER_C, 'What is the pressure class of our 6-inch HDPE pipe?');
    assert.ok(stored.id, 'precondition: one stored query for the fresh user');
    await assert.rejects(
        () => queryService.deleteHistory(stored.id, USER_B),
        /Query not found/,
        'user B cannot delete user C query',
    );
    await queryService.deleteHistory(stored.id, USER_C);
    const afterC = await queryService.listHistory(USER_C);
    assert.strictEqual(afterC.length, 0, 'user C deleted their own query');
    console.log('✅ Test 6 passed\n');
}

async function main() {
    try {
        await test1_retrievalIsTenantIsolated();
        await test2_promptGrounding();
        await test3_askStoresScopedHistory();
        await test4_noSourcesNoAiCall();
        await test5_chatFlow();
        await test5_deleteHistoryScoped();
        console.log('🎉 ALL ASK-AI SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
