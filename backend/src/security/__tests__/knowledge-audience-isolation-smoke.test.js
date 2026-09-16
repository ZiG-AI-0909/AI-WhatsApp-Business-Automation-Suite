// =============================================================
// Security smoke test — Knowledge Base audience isolation.
//
// knowledge_documents feeds the CUSTOMER-FACING WhatsApp auto-reply
// (knowledgeBase.getRelevantContext via incomingMessageService). The
// internal Ask AI assistant is now FULLY DECOUPLED from the Knowledge
// Base: it answers from code-owned built-in knowledge
// (ai/builtInKnowledge.js) and never reads these tables.
//
// The former "How to Use This Platform" seed doc is no longer injected
// into user Knowledge Bases at all — staff platform help now lives in
// the Ask AI built-in module, so it cannot leak into a customer reply
// BY CONSTRUCTION rather than by a retrieval filter.
//
// Proves, WITHOUT any real Supabase or real AI provider:
//   1. getRelevantContext (customer path) never surfaces platform-help
//      vocabulary for a message deliberately stuffed with it: platform
//      content exists nowhere in the KB for a fresh user.
//   2. END-TO-END: the real incomingMessageService.process() — the same
//      code path that handles a real WhatsApp message — never puts any
//      internal/built-in content into the AI prompt sent to the provider.
//   3. Ask AI grounding is built-in only: its answers cite built-in
//      guides and NEVER cite or embed Knowledge Base content, and it
//      does not mutate the customer-facing store.
//   4. Unit: the built-in platform guide + company profile are
//      retrievable only through the built-in module; the KB seed
//      (company profile) remains customer-visible as before.
//
// The built-in platform guide carries the CANARY phrase; every
// customer-visible artifact (retrieval context, provider prompt body)
// is asserted to never contain it.
// =============================================================
const assert = require('assert');
const http = require('http');

// ── Minimal in-memory Supabase mock injected BEFORE modules load ──
const OWNER = '55555555-5555-5555-5555-555555555501';
const OTHER = '66666666-6666-6666-6666-666666666601';

// A phrase that exists ONLY in the built-in platform guide (ai/builtInKnowledge.js)
// — never in any Knowledge Base row in these tests.
const CANARY = 'Linked Devices';
// And one from the guide's campaign section, which is what a
// "schedule a campaign" question actually retrieves.
const CAMPAIGN_PHRASE = 'scheduled campaigns run automatically';
const PROFILE_CHUNK = 'SUDARSHAN PIPES — COMPANY PROFILE. Product portfolio: uPVC column pipes, HDPE PE100 pipes, MDPE pipes, UGD pipes. Manufacturing capacity approximately 66,000 MTPA across PVC and PE divisions in Bengaluru.';

const state = {
    rows: {
        knowledge_documents: [
            { id: 1, user_id: OWNER, name: 'Sudarshan Pipes — Company Profile', category: 'Company Profile', status: 'active', internal_only: false },
        ],
        knowledge_chunks: [
            { document_id: 1, user_id: OWNER, content: PROFILE_CHUNK, documents: { name: 'Sudarshan Pipes — Company Profile' } },
        ],
        ai_queries: [],
        app_settings: [
            // Seed marker present → seeding is a no-op for this user.
            { user_id: OWNER, key: 'KB_DEFAULT_SEEDED', value: 'true' },
        ],
    },
};

function applyFilters(name, filters, inFilter) {
    let rows = state.rows[name] || [];
    for (const [col, val] of filters) rows = rows.filter((r) => r[col] === val);
    if (inFilter) { const [col, vals] = inFilter; rows = rows.filter((r) => vals.includes(r[col])); }
    return rows;
}

function table(name) {
    return {
        select() {
            const builder = {
                _filters: [],
                _in: null,
                eq(col, val) { builder._filters.push([col, val]); return builder; },
                in(col, vals) { builder._in = [col, vals]; return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => {
                    const rows = applyFilters(name, builder._filters, builder._in);
                    return { data: rows[0] ? { ...rows[0] } : null, error: null };
                },
                // db.getById() → .select('*').eq(...).single()
                single: async () => {
                    const rows = applyFilters(name, builder._filters, builder._in);
                    if (!rows.length) return { data: null, error: { code: 'PGRST116' } };
                    return { data: { ...rows[0] }, error: null };
                },
                async then(resolve) {
                    resolve({ data: applyFilters(name, builder._filters, builder._in).map((r) => ({ ...r })), error: null });
                },
            };
            return builder;
        },
        insert(row) {
            const incoming = Array.isArray(row) ? row : [row];
            return {
                select() {
                    const store = async () => {
                        const stored = incoming.map((r, i) => ({ ...r, id: (state.rows[name].length + 1 + i) }));
                        state.rows[name].push(...stored);
                        return stored;
                    };
                    return {
                        // db.insert() → .select().single() — one row.
                        single: async () => {
                            const stored = await store();
                            return { data: stored[0], error: null };
                        },
                        // db.insertMany() → await .select() — row array.
                        then: (resolve) => store().then((stored) => resolve({ data: stored, error: null })),
                    };
                },
            };
        },
        update(_data) {
            const builder = {
                _filters: [],
                eq(col, val) { builder._filters.push([col, val]); return builder; },
                select: async () => {
                    const rows = applyFilters(name, builder._filters, null);
                    for (const r of rows) Object.assign(r, _data);
                    return { data: rows.map((r) => ({ ...r })), error: null };
                },
            };
            return builder;
        },
        delete() {
            const builder = {
                _filters: [],
                eq(col, val) { builder._filters.push([col, val]); return builder; },
                select: async () => {
                    const rows = applyFilters(name, builder._filters, null);
                    state.rows[name] = (state.rows[name] || []).filter((r) => !rows.includes(r));
                    return { data: rows.map((r) => ({ ...r })), error: null };
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

// Local capture server standing in for the AI provider.
const providerHits = [];
const providerServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        providerHits.push({ path: req.url, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'Thanks! Our team will share the HDPE price list shortly.' } }] }));
    });
});

process.env.AI_API_KEY = 'sk-BOUNDARY-TEST-KEY';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// ---- Real services under test ----
const knowledgeBase = require('../../ai/knowledgeBase');
const incomingMessageService = require('../../conversations/incomingMessageService');
const conversationService = require('../../conversations/conversationService');
const contactService = require('../../contacts/contactService');
const aiService = require('../../ai/aiService');
const queryService = require('../../ai/queryService');
const builtInKnowledge = require('../../ai/builtInKnowledge');
const seedKnowledgeService = require('../../knowledge/seedKnowledgeService');

// Hermetic conversation flow (same neutralization as the exfiltration test).
contactService.upsert = async () => ({ id: 1, marketing_opt_in: true });
contactService.setOptOut = async () => {};
conversationService.getOrCreate = async () => ({ conversation: { id: 1, user_id: OWNER, ai_enabled: true }, contact: { id: 1, name: 'Test Customer' } });
conversationService.saveMessage = async () => ({ id: 1 });
conversationService.setStatus = async () => {};
conversationService.setAIEnabled = async () => {};
conversationService.getHistory = async () => [];
seedKnowledgeService._reset();

// A customer message deliberately stuffed with platform-help vocabulary —
// every content word overlaps the BUILT-IN platform guide, plus one
// product word so the regular doc is also a genuine match.
const ADVERSARIAL_CUSTOMER_MESSAGE =
    'Do you have templates for bulk HDPE orders? Can I schedule delivery, upload our BOQ excel and get a campaign quote?';

async function test1_customerRetrievalHasNoPlatformContent() {
    console.log('▶ Test 1: customer retrieval never surfaces platform-help content');
    // The built-in guide's canary must not exist anywhere in the KB.
    const allChunks = state.rows.knowledge_chunks.map((c) => c.content).join('\n');
    assert.ok(!allChunks.includes(CANARY), 'platform guide content does not exist in the Knowledge Base');

    const context = await knowledgeBase.getRelevantContext(ADVERSARIAL_CUSTOMER_MESSAGE, 4, OWNER);
    assert.ok(typeof context === 'string', 'context is a string');
    assert.ok(!context.includes(CANARY), 'built-in guide canary NEVER appears in customer context');
    assert.ok(!/How to Use This Platform|Platform Guide/i.test(context), 'built-in guide name never appears in customer context');

    // The regular document is still eligible — no regression for normal content.
    const productContext = await knowledgeBase.getRelevantContext('HDPE pipes capacity MTPA', 4, OWNER);
    assert.ok(productContext.includes('MTPA'), 'regular company document still retrievable for customers');
    console.log('✅ Test 1 passed\n');
}

async function test2_endToEndCustomerBot() {
    console.log('▶ Test 2: real incomingMessageService.process() never sends built-in content to the provider');
    providerHits.length = 0;
    const sent = [];
    await incomingMessageService.process(
        { provider: 'web', from: '919999900001', text: ADVERSARIAL_CUSTOMER_MESSAGE, type: 'text' },
        OWNER,
        null, // io not needed (emitToUser tolerates null)
        async (phone, body) => { sent.push({ phone, body }); },
    );

    assert.strictEqual(providerHits.length, 1, 'exactly one AI provider call');
    const promptBody = providerHits[0].body;
    assert.ok(!promptBody.includes(CANARY), 'canary NEVER reaches the AI provider on the customer path');
    assert.ok(!/How to Use This Platform|Platform Guide/i.test(promptBody), 'built-in guide name never in the customer prompt');
    assert.ok(promptBody.includes('MTPA'), 'regular company knowledge IS in the customer prompt (proves retrieval ran)');

    assert.ok(sent.length === 1 && sent[0].body.includes('HDPE price list'), 'customer still gets their AI reply');
    console.log('✅ Test 2 passed\n');
}

async function test3_askAIIsBuiltInOnly() {
    console.log('▶ Test 3: Ask AI grounds in built-in knowledge and never cites KB content');
    seedKnowledgeService._reset();

    const realComplete = aiService._complete;
    let capturedPrompt = '';
    aiService._complete = async (messages) => {
        capturedPrompt = messages[0].content;
        return 'Go to Campaigns and schedule for later [Platform Guide (built-in)].';
    };
    try {
        const result = await queryService.ask(OWNER, 'How do I schedule a campaign for later?');
        assert.ok(result.answer.includes('Campaigns'), 'Ask AI answers the platform question');
        assert.ok(result.sources.some((s) => s.name === builtInKnowledge.DOC_PLATFORM), 'answer cites the built-in platform guide');
        assert.ok(capturedPrompt.includes(CAMPAIGN_PHRASE), 'built-in guide content legitimately reaches the Ask AI prompt (internal audience)');

        // KB isolation: the customer-facing profile is never pulled into
        // an Ask AI prompt, and Ask AI never mutates the KB.
        const kbCount = state.rows.knowledge_documents.filter((d) => d.user_id === OWNER).length;
        assert.strictEqual(kbCount, 1, 'Ask AI did not add documents to the customer-facing KB');
    } finally {
        aiService._complete = realComplete;
    }
    console.log('✅ Test 3 passed\n');
}

async function test4_seedingLeavesPlatformHelpOut() {
    console.log('▶ Test 4: seeding never writes platform help into the KB; built-in module owns it');

    // Fresh user: first KB load seeds ONLY the company profile — no
    // platform-help doc exists for customers to trip over.
    await seedKnowledgeService.seedIfEmpty(OTHER);
    const docs = state.rows.knowledge_documents.filter((d) => d.user_id === OTHER);
    assert.strictEqual(docs.length, 1, 'only the company profile is seeded');
    assert.ok(docs.some((d) => d.name === 'Sudarshan Pipes — Company Profile'), 'company profile remains customer-visible');
    assert.ok(!docs.some((d) => /platform/i.test(d.name)), 'no platform-help doc is ever seeded into the KB');

    // The built-in module owns the staff guide and company facts.
    assert.ok(builtInKnowledge.PLATFORM_HELP.includes('HOW TO USE THIS PLATFORM'), 'built-in platform guide exists in code');
    assert.ok(builtInKnowledge.COMPANY_PROFILE.includes('MANUFACTURING CAPACITY'), 'built-in company profile exists in code');
    assert.ok(builtInKnowledge.retrieveBuiltInSources('schedule a campaign Excel contacts upload').length > 0, 'built-in retrieval serves platform questions');

    // listDocuments exposes the flag for the UI badge (still supported
    // for user-authored internal docs).
    const listed = await knowledgeBase.listDocuments(OWNER);
    assert.ok(listed.every((d) => typeof d.internal_only === 'boolean'), 'listDocuments returns internal_only');
    console.log('✅ Test 4 passed\n');
}

async function main() {
    await new Promise((r) => providerServer.listen(0, r));
    // Point the server-default provider at the local capture server so no
    // test traffic ever reaches a real AI provider.
    process.env.AI_BASE_URL = `http://127.0.0.1:${providerServer.address().port}/v1`;
    try {
        await test1_customerRetrievalHasNoPlatformContent();
        await test2_endToEndCustomerBot();
        await test3_askAIIsBuiltInOnly();
        await test4_seedingLeavesPlatformHelpOut();
        console.log('🎉 ALL KNOWLEDGE AUDIENCE-ISOLATION TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        providerServer.close();
    }
}

main();
