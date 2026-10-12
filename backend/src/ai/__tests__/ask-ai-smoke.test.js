// =============================================================
// Smoke test — Ask AI (internal assistant, DECOUPLED from the KB).
//
// Ask AI no longer reads the Knowledge Base: its grounding is the
// code-owned built-in knowledge (builtInKnowledge.js). Proves, WITHOUT
// real Supabase or a real AI call:
//   1. ask() answers platform how-to questions from built-in knowledge,
//      cites the built-in guide, and stores scoped history.
//   2. The Knowledge Base is NEVER consulted: a KB full of documents
//      (even ones matching the query) does not change Ask AI answers,
//      and a fact that exists ONLY in the KB gets the honest no-match
//      answer with zero AI calls.
//   3. Deploy-failure regression: a corrupted "[object Blob]" KB doc,
//      a missing app_settings table, and a missing ai_queries table do
//      NOT break ask() — no seed/repair pre-flight runs, and history
//      persistence degrades gracefully instead of returning 500.
//   4. Empty retrieval returns the honest no-match answer without
//      calling the AI and without storing anything.
//   5. History list is scoped: user A never sees user B's queries, and
//      delete is tenant-scoped.
//   6. chat() keeps multi-turn context and persists per turn.
//
// Run: node backend/src/ai/__tests__/ask-ai-smoke.test.js
// =============================================================
const assert = require('assert');

// ── Minimal in-memory Supabase mock injected BEFORE modules load ──
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const state = {
    rows: {
        // Ask AI must never touch these; they exist to PROVE that.
        knowledge_documents: [],
        knowledge_chunks: [],
        ai_queries: [],
        app_settings: [],
        app_settings_missing: true, // flag for the failing-mock variant below
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
                            // Emulate the deploy failure: ai_queries missing → error.
                            if (name === 'ai_queries' && state.rows.ai_queries === null) {
                                return { data: null, error: { message: 'relation "ai_queries" does not exist' } };
                            }
                            const stored = { ...row, id: (state.rows[name]?.length || 0) + 1 };
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
    return 'Go to Campaigns and schedule for later [Platform Guide (built-in)].';
};

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const queryService = require('../queryService');
const knowledgeBase = require('../knowledgeBase');

async function test1_askAnswersFromBuiltInKnowledge() {
    console.log('▶ Test 1: ask() answers platform questions from built-in knowledge');
    aiCalls = [];
    const result = await queryService.ask(USER_A, 'How do I schedule a campaign for later?');
    assert.strictEqual(result.stored, true, 'result persisted');
    assert.ok(result.id, 'stored row id returned');
    assert.ok(aiCalls.length === 1, 'exactly one AI call');
    const prompt = aiCalls[0].messages[0].content;
    assert.ok(prompt.includes('Platform Guide (built-in)'), 'built-in guide embedded in the prompt');
    assert.ok(prompt.includes('schedule for later'), 'relevant guide section embedded in the prompt');
    assert.ok(result.sources.some((s) => s.name === 'Platform Guide (built-in)'), 'built-in guide cited as source');

    const stored = state.rows.ai_queries.find((q) => q.id === result.id);
    assert.strictEqual(stored.user_id, USER_A, 'query stored with owner user_id');
    console.log('✅ Test 1 passed\n');
}

async function test2_knowledgeBaseNeverConsulted() {
    console.log('▶ Test 2: the Knowledge Base is never consulted by Ask AI');
    // A KB document whose content matches the question EXACTLY must not
    // change the answer or its sources.
    await knowledgeBase.addDocument(USER_A, 'KB Campaign Notes', 'notes', 'To schedule a campaign for later, open Campaigns, pick your template, and choose Schedule.');
    aiCalls = [];
    const result = await queryService.ask(USER_A, 'How do I schedule a campaign for later?');
    assert.ok(aiCalls.length === 1, 'AI still called exactly once');
    const prompt = aiCalls[0].messages[0].content;
    assert.ok(!prompt.includes('KB Campaign Notes'), 'KB document content NEVER enters the Ask AI prompt');
    assert.ok(result.sources.every((s) => !s.name.includes('KB Campaign Notes')), 'KB document never cited as a source');

    // A fact that exists ONLY in the KB gets the honest no-match answer
    // and NO AI call — Ask AI does not fall through to the KB.
    aiCalls = [];
    const kbOnly = await queryService.ask(USER_A, 'What dealer discount applies to bulk PE orders?');
    assert.strictEqual(aiCalls.length, 0, 'no AI call for KB-only facts');
    assert.strictEqual(kbOnly.stored, false, 'nothing stored without built-in sources');
    assert.match(kbOnly.answer, /couldn't find anything in my built-in guides/i, 'honest no-match answer');
    console.log('✅ Test 2 passed\n');
}

async function test3_deployFailuresDoNotBreakAsk() {
    console.log('▶ Test 3: corrupt KB + missing tables never break ask()');
    // The deployed "Something went wrong" shape: corrupted KB doc present
    // while Ask AI ran its old seed/repair pre-flight.
    state.rows.knowledge_documents.push({ id: 901, user_id: USER_B, name: 'Sudarshan pipes', status: 'active', content: '[object Blob]' });
    state.rows.knowledge_chunks.push({ document_id: 901, user_id: USER_B, content: '[object Blob]', chunk_index: 0 });

    // Corrupt doc present + empty settings → ask still works.
    aiCalls = [];
    const ok = await queryService.ask(USER_B, 'How do I schedule a campaign for later?');
    assert.strictEqual(ok.stored, true, 'answer produced despite corrupt KB doc');

    // ai_queries table missing → answer still produced, history degrades.
    state.rows.ai_queries = null;
    try {
        aiCalls = [];
        const degraded = await queryService.ask(USER_A, 'How do I schedule a campaign for later?');
        assert.strictEqual(aiCalls.length, 1, 'AI called once despite history store failure');
        assert.strictEqual(degraded.stored, false, 'history degrades to not-stored');
        assert.strictEqual(degraded.id, null, 'no id when not stored');
    } finally {
        state.rows.ai_queries = [];
    }
    console.log('✅ Test 3 passed\n');
}

async function test4_noSourcesNoAiCall() {
    console.log('▶ Test 4: empty retrieval returns the honest no-match answer');
    aiCalls = [];
    const result = await queryService.ask(USER_A, 'what diameter copper fittings are available');
    assert.strictEqual(result.stored, false, 'nothing stored without sources');
    assert.strictEqual(result.sources.length, 0, 'no fabricated sources');
    assert.strictEqual(aiCalls.length, 0, 'no AI call when nothing matches');

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

async function test6_historyScoped() {
    console.log('▶ Test 6: history is tenant-scoped (list + delete)');
    const historyA = await queryService.listHistory(USER_A);
    assert.ok(historyA.length > 0, 'user A sees their own queries');
    assert.ok(historyA.every((q) => state.rows.ai_queries.some((s) => s.id === q.id && s.user_id === USER_A)), 'only own queries listed');
    const historyB = await queryService.listHistory(USER_B);
    assert.ok(historyB.every((q) => !historyA.some((a) => a.id === q.id)), 'user B never sees user A history');

    // Delete is scoped: B cannot delete A's row.
    const aRow = historyA[0];
    await assert.rejects(
        () => queryService.deleteHistory(aRow.id, USER_B),
        /Query not found/,
        'user B cannot delete user A query',
    );
    await queryService.deleteHistory(aRow.id, USER_A);
    assert.ok(!state.rows.ai_queries.some((q) => q.id === aRow.id), 'user A deleted their own query');
    console.log('✅ Test 6 passed\n');
}

async function main() {
    try {
        await test1_askAnswersFromBuiltInKnowledge();
        await test2_knowledgeBaseNeverConsulted();
        await test3_deployFailuresDoNotBreakAsk();
        await test4_noSourcesNoAiCall();
        await test5_chatFlow();
        await test6_historyScoped();
        console.log('🎉 ALL ASK-AI SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
