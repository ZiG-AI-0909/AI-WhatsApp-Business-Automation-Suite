// =============================================================
// Security smoke test — Knowledge Base audience isolation.
//
// knowledge_documents feeds BOTH audiences:
//   - the CUSTOMER-FACING WhatsApp auto-reply
//     (knowledgeBase.getRelevantContext via incomingMessageService)
//   - the internal Ask AI tool (queryService.retrieveSources)
//
// Documents flagged internal_only = true (the seeded "How to Use This
// Platform" guide, staff procedures, internal pricing) must NEVER be
// eligible for a customer reply, no matter how strongly a customer's
// message lexically overlaps platform vocabulary. Ask AI must still see
// BOTH internal-only and regular documents side by side.
//
// Proves, WITHOUT any real Supabase or real AI provider:
//   1. getRelevantContext (customer path) excludes internal_only docs
//      even for a message deliberately stuffed with platform words.
//   2. END-TO-END: the real incomingMessageService.process() — the same
//      code path that handles a real WhatsApp message — never puts
//      internal content into the AI prompt sent to the provider.
//   3. Ask AI retrieval returns the internal-only platform doc for a
//      platform question AND the Company Profile for a product
//      question — both audiences coexist for internal users.
//   4. Unit: addDocument/updateDocument persist the flag; the seeded
//      platform doc is created internal_only.
//
// The internal content carries a unique CANARY phrase; every customer-
// visible artifact (retrieval context, provider prompt body) is
// asserted to never contain it.
// =============================================================
const assert = require('assert');
const http = require('http');

// ── Minimal in-memory Supabase mock injected BEFORE modules load ──
const OWNER = '55555555-5555-5555-5555-555555555501';
const OTHER = '66666666-6666-6666-6666-666666666601';

const CANARY = 'CANARY-INTERNAL-ONLY-LINKED-DEVICES';
const PLATFORM_CHUNK = `HOW TO USE THIS PLATFORM — CONNECTING WHATSAPP: go to WhatsApp Connection and ${CANARY}. CREATING CAMPAIGNS: upload an Excel file of contacts, write your message, choose a country code, then send immediately or schedule for later — scheduled campaigns run in the background. INBOX: each conversation has an AI toggle. DOCUMENT INTELLIGENCE: upload a BOQ for extraction.`;
const PROFILE_CHUNK = 'SUDARSHAN PIPES — COMPANY PROFILE. Product portfolio: uPVC column pipes, HDPE PE100 pipes, MDPE pipes, UGD pipes. Manufacturing capacity approximately 66,000 MTPA across PVC and PE divisions in Bengaluru.';

const state = {
    rows: {
        knowledge_documents: [
            { id: 1, user_id: OWNER, name: 'Sudarshan Pipes — Company Profile', category: 'Company Profile', status: 'active', internal_only: false },
            { id: 2, user_id: OWNER, name: 'How to Use This Platform', category: 'Platform Help', status: 'active', internal_only: true },
        ],
        knowledge_chunks: [
            { document_id: 1, user_id: OWNER, content: PROFILE_CHUNK, documents: { name: 'Sudarshan Pipes — Company Profile' } },
            { document_id: 2, user_id: OWNER, content: PLATFORM_CHUNK, documents: { name: 'How to Use This Platform' } },
        ],
        ai_queries: [],
        app_settings: [
            // Both seed markers present → seeding is a no-op for this user.
            { user_id: OWNER, key: 'KB_DEFAULT_SEEDED', value: 'true' },
            { user_id: OWNER, key: 'KB_PLATFORM_SEEDED', value: 'true' },
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
// every content word overlaps the internal-only platform doc, plus one
// product word so the regular doc is also a genuine match.
const ADVERSARIAL_CUSTOMER_MESSAGE =
    'Do you have templates for bulk HDPE orders? Can I schedule delivery, upload our BOQ excel and get a campaign quote?';

async function test1_customerRetrievalExcludesInternal() {
    console.log('▶ Test 1: getRelevantContext (customer path) excludes internal_only docs');
    const context = await knowledgeBase.getRelevantContext(ADVERSARIAL_CUSTOMER_MESSAGE, 4, OWNER);
    assert.ok(typeof context === 'string', 'context is a string');
    assert.ok(!context.includes(CANARY), 'internal canary NEVER appears in customer context');
    assert.ok(!/How to Use This Platform/i.test(context), 'internal doc name never appears in customer context');

    // The regular document is still eligible — no regression for normal content.
    const productContext = await knowledgeBase.getRelevantContext('HDPE pipes capacity MTPA', 4, OWNER);
    assert.ok(productContext.includes('MTPA'), 'regular (non-internal) document still retrievable for customers');

    // And the exclusion is not score-based luck: even a PURE platform
    // query (zero product overlap) yields no platform content at all.
    const purePlatform = await knowledgeBase.getRelevantContext('schedule campaign Excel upload BOQ templates', 4, OWNER);
    assert.ok(!purePlatform.includes(CANARY), 'internal canary absent even for a pure platform query');
    assert.ok(!/CONNECTING WHATSAPP/i.test(purePlatform), 'internal content absent even for a pure platform query');
    console.log('✅ Test 1 passed\n');
}

async function test2_endToEndCustomerBot() {
    console.log('▶ Test 2: real incomingMessageService.process() never sends internal content to the provider');
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
    assert.ok(!/How to Use This Platform|Platform Help/i.test(promptBody), 'internal doc name/category never in the customer prompt');
    assert.ok(promptBody.includes('MTPA'), 'regular company knowledge IS in the customer prompt (proves retrieval ran, filter is selective)');

    assert.ok(sent.length === 1 && sent[0].body.includes('HDPE price list'), 'customer still gets their AI reply');
    console.log('✅ Test 2 passed\n');
}

async function test3_askAISeesBothAudiences() {
    console.log('▶ Test 3: Ask AI retrieves internal-only AND regular docs side by side');
    seedKnowledgeService._reset();

    const platformSources = await queryService.retrieveSources(OWNER, 'schedule a campaign Excel contacts upload');
    assert.ok(platformSources.length > 0, 'platform question retrieves sources');
    assert.ok(platformSources.some((s) => s.docName === 'How to Use This Platform'),
        'internal-only platform doc IS retrievable by Ask AI');

    const productSources = await queryService.retrieveSources(OWNER, 'HDPE manufacturing capacity MTPA');
    assert.ok(productSources.some((s) => s.docName === 'Sudarshan Pipes — Company Profile'),
        'company profile still retrievable by Ask AI');

    // The full ask() flow: internal doc powers the grounded answer.
    const realComplete = aiService._complete;
    let capturedPrompt = '';
    aiService._complete = async (messages) => {
        capturedPrompt = messages[0].content;
        return 'Go to Campaigns and schedule for later [How to Use This Platform].';
    };
    try {
        const result = await queryService.ask(OWNER, 'How do I schedule a campaign for later?');
        assert.ok(result.answer.includes('Campaigns'), 'Ask AI answers the platform question');
        assert.ok(result.sources.some((s) => s.name === 'How to Use This Platform'), 'answer cites the internal-only doc');
        assert.ok(capturedPrompt.includes(CANARY), 'internal content legitimately reaches the Ask AI prompt');
    } finally {
        aiService._complete = realComplete;
    }
    console.log('✅ Test 3 passed\n');
}

async function test4_flagPersistenceAndSeeding() {
    console.log('▶ Test 4: internal_only persists through add/update and the platform seed sets it');

    // addDocument round-trip.
    const docId = await knowledgeBase.addDocument(OWNER, 'Staff Pricing Sheet', 'Pricing', 'Dealer discount is 12% on bulk PE orders. INTERNAL-STAFF-PRICING.', null, { internalOnly: true });
    const storedDoc = state.rows.knowledge_documents.find((d) => d.id === docId);
    assert.strictEqual(storedDoc.internal_only, true, 'addDocument persists internal_only=true');
    assert.ok(state.rows.knowledge_chunks.some((c) => c.document_id === docId && c.content.includes('INTERNAL-STAFF-PRICING')), 'chunks created for the internal doc');

    // Default stays false — every normal upload remains customer-visible.
    const normalId = await knowledgeBase.addDocument(OWNER, 'UGD Specs', 'Product Specs', 'UGD pipes per IS 651:2015 for municipal water supply.');
    const normalDoc = state.rows.knowledge_documents.find((d) => d.id === normalId);
    assert.strictEqual(normalDoc.internal_only, false, 'documents default to customer-visible');

    // updateDocument toggles the flag (the UI checkbox path).
    await knowledgeBase.updateDocument(normalId, OWNER, { internal_only: true });
    const toggled = state.rows.knowledge_documents.find((d) => d.id === normalId);
    assert.strictEqual(toggled.internal_only, true, 'updateDocument persists internal_only');

    // The seeded platform doc itself is created internal-only (fresh user
    // with the default profile already present, per the seeding rules).
    await knowledgeBase.addDocument(OTHER, 'Sudarshan Pipes — Company Profile', 'Company Profile', PROFILE_CHUNK);
    await seedKnowledgeService._seedPlatformDoc(OTHER);
    const seededPlatform = state.rows.knowledge_documents.find((d) => d.user_id === OTHER && d.name === 'How to Use This Platform');
    assert.ok(seededPlatform, 'platform seed created');
    assert.strictEqual(seededPlatform.internal_only, true, 'seeded platform doc is internal_only');

    // listDocuments exposes the flag for the UI badge.
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
        await test1_customerRetrievalExcludesInternal();
        await test2_endToEndCustomerBot();
        await test3_askAISeesBothAudiences();
        await test4_flagPersistenceAndSeeding();
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
