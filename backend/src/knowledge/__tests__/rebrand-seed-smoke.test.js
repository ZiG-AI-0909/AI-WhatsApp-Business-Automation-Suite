// =============================================================
// Rebrand + seeding smoke test.
//
// Verifies, WITHOUT real Supabase:
//   1. A fresh user (zero knowledge documents) is auto-seeded with
//      the "Sudarshan Pipes — Company Profile" document on their
//      first Knowledge Base load — a normal, editable document row
//      plus retrieval chunks, nothing special/protected about it.
//   2. An existing user with their OWN documents and customized
//      app_settings is NOT touched by seeding (seed only runs when
//      the knowledge base is completely empty).
//   3. A user who DELETED the seed document is not re-seeded on the
//      next load (respects their explicit choice).
//   4. GET /api/settings defaults still resolve for a user with no
//      stored settings, and the seed content contains the framing
//      guard for company-reported figures.
//
// Run: node backend/src/knowledge/__tests__/rebrand-seed-smoke.test.js
// =============================================================
const assert = require('assert');

// ---- Shared in-memory Supabase mock (injected at the client boundary) ----
const state = { rows: { knowledge_documents: [], knowledge_chunks: [], app_settings: [] } };

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        rows: state.rows[name],
        select(_cols, options = {}) {
            const filters = [];
            const headCount = !!(options.count && options.head);
            const run = async () => state.rows[name].filter(r => filters.every(f =>
                f.anyOf ? Array.isArray(f.val) && f.val.includes(r[f.col]) : r[f.col] === f.val));
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                in(col, vals) { filters.push({ col, val: vals, anyOf: true }); return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => ({ data: (await run())[0] || null, error: null }),
                single: async () => ({ data: (await run())[0] || null, error: null }),
                async then(resolve) {
                    if (headCount) return resolve({ data: null, error: null, count: (await run()).length });
                    return resolve({ data: await run(), error: null });
                },
            };
            return builder;
        },
        insert(rowOrRows) {
            const isBatch = Array.isArray(rowOrRows);
            // Emulate DB column defaults (see supabase-data-migration.sql).
            const DEFAULTS = { knowledge_documents: { status: 'active' } };
            const withDefaults = (row) => ({ ...(DEFAULTS[name] || {}), ...row });
            const apply = () => {
                if (isBatch) {
                    const stored = rowOrRows.map((r, i) => ({ ...withDefaults(r), id: state.rows[name].length + 1 + i }));
                    state.rows[name].push(...stored);
                    return stored;
                }
                const idx = state.rows[name].findIndex(r => r.user_id === rowOrRows.user_id && r.key === rowOrRows.key);
                if (idx >= 0) { state.rows[name][idx] = { ...state.rows[name][idx], ...withDefaults(rowOrRows) }; return [state.rows[name][idx]]; }
                const stored = { ...withDefaults(rowOrRows), id: state.rows[name].length + 1 };
                state.rows[name].push(stored);
                return [stored];
            };
            return {
                select() {
                    return {
                        // Thenable: awaited directly by db.insertMany (batch path).
                        then: (resolve) => resolve({ data: apply(), error: null }),
                        single: async () => {
                            const out = apply();
                            return { data: out[0], error: null };
                        },
                    };
                },
            };
        },
        delete() {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].filter(r => !filters.every(f => r[f.col] === f.val));
                    return { data: [], error: null };
                },
                async then(resolve) {
                    state.rows[name] = state.rows[name].filter(r => !filters.every(f => r[f.col] === f.val));
                    return resolve({ data: [], error: null });
                },
            };
            return builder;
        },
        update(_data) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].map(r =>
                        filters.every(f => r[f.col] === f.val) ? { ...r, ..._data } : r);
                    return { data: state.rows[name].filter(r => filters.every(f => r[f.col] === f.val)), error: null };
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

process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'mock-secret';

const db = require('../../database/db');
const seedService = require('../../knowledge/seedKnowledgeService');
const knowledgeBase = require('../../ai/knowledgeBase');
const knowledgeRoute = require('../../routes/knowledge');

const FRESH_USER = 'aaaaaaaa-1111-1111-1111-111111111111';
const EXISTING_USER = 'bbbbbbbb-2222-2222-2222-222222222222';

function findRoute(router, method, routePath) {
    const layer = router.stack.find(l => l.route?.path === routePath && l.route?.methods?.[method]);
    assert.ok(layer, `${method.toUpperCase()} ${routePath} route exists`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function test1_freshUserSeeded() {
    console.log('▶ Test 1: fresh signup is auto-seeded on first Knowledge Base load');
    assert.strictEqual(state.rows.knowledge_documents.filter(d => d.user_id === FRESH_USER).length, 0, 'precondition: fresh user has no documents');

    // Simulate GET /api/knowledge for the fresh user.
    const handler = findRoute(knowledgeRoute, 'get', '/');
    const req = { user: { id: FRESH_USER, email: 'new@sudarshanpipes.com' } };
    let responseBody = null;
    const res = {
        json: (data) => { responseBody = data; },
        status(code) { return { json: (d) => { responseBody = d; } }; },
    };
    await handler(req, res);

    const docs = state.rows.knowledge_documents.filter(d => d.user_id === FRESH_USER);
    assert.strictEqual(docs.length, 1, 'exactly one seed document created');
    assert.strictEqual(docs[0].name, 'Sudarshan Pipes — Company Profile');
    assert.strictEqual(docs[0].category, 'Company Profile');
    assert.strictEqual(docs[0].status, 'active', 'a normal active document — not locked/protected');

    // The first list response already includes the seed doc.
    assert.ok(Array.isArray(responseBody) && responseBody.length === 1, 'seed visible in the very first list response');

    // Retrieval chunks were created so getRelevantContext works.
    const chunks = state.rows.knowledge_chunks.filter(c => c.user_id === FRESH_USER);
    assert.ok(chunks.length >= 1, 'seed document was chunked for retrieval');
    assert.ok(chunks.some(c => c.content.includes('Sudarshan Extrusions')), 'chunks contain real profile content');

    // The route handler returns the doc with content_length (UI-compatible).
    assert.ok(responseBody[0].content_length > 0, 'list shape matches Knowledge Base UI expectations');

    // AI retrieval on a relevant query finds the profile.
    const context = await knowledgeBase.getRelevantContext('HDPE pipes manufacturing capacity', 4, FRESH_USER);
    assert.ok(context.includes('Sudarshan Pipes'), 'AI context includes the seed document');
    console.log('✅ Test 1 passed\n');
}

async function test2_existingUserUntouched() {
    console.log('▶ Test 2: existing user own knowledge/settings are NOT overwritten');
    // Existing user: one custom doc + customized settings.
    await knowledgeBase.addDocument(EXISTING_USER, 'My custom pricing notes', 'Pricing', 'Dealer discount is 12% on bulk PE orders.');
    state.rows.app_settings.push(
        { key: 'BUSINESS_NAME', value: 'My Own Traders', user_id: EXISTING_USER },
        { key: 'AI_API_KEY', value: 'sk-custom', user_id: EXISTING_USER },
    );
    const docsBefore = state.rows.knowledge_documents.filter(d => d.user_id === EXISTING_USER).length;
    const customized = Object.fromEntries(state.rows.app_settings
        .filter(r => r.user_id === EXISTING_USER && r.key !== 'KB_DEFAULT_SEEDED')
        .map(r => [r.key, r.value]));

    seedService._reset();
    // Load dashboard + knowledge as the existing user (fire-and-forget path).
    await seedService.seedIfEmpty(EXISTING_USER);

    const docsAfter = state.rows.knowledge_documents.filter(d => d.user_id === EXISTING_USER);
    assert.strictEqual(docsAfter.length, docsBefore, 'no document added for existing user');
    assert.ok(!docsAfter.some(d => d.name.includes('Sudarshan')), 'seed document NOT injected');
    const customizedAfter = Object.fromEntries(state.rows.app_settings
        .filter(r => r.user_id === EXISTING_USER && r.key !== 'KB_DEFAULT_SEEDED')
        .map(r => [r.key, r.value]));
    assert.deepStrictEqual(customizedAfter, customized, 'customized setting values untouched (internal seed marker may be written)');
    console.log('✅ Test 2 passed\n');
}

async function test3_deletedSeedNotReSeeded() {
    console.log('▶ Test 3: user who deleted the seed is not re-seeded');
    const docs = state.rows.knowledge_documents.filter(d => d.user_id === FRESH_USER);
    assert.strictEqual(docs.length, 1);
    await knowledgeBase.deleteDocument(docs[0].id, FRESH_USER);

    seedService._reset();
    // Two subsequent loads — must stay empty both times.
    await seedService.seedIfEmpty(FRESH_USER);
    assert.strictEqual(state.rows.knowledge_documents.filter(d => d.user_id === FRESH_USER).length, 0, 'no re-seed after deletion (1st load)');
    await seedService.seedIfEmpty(FRESH_USER);
    assert.strictEqual(state.rows.knowledge_documents.filter(d => d.user_id === FRESH_USER).length, 0, 'no re-seed after deletion (2nd load)');
    console.log('✅ Test 3 passed\n');
}

async function test4_seedContentFraming() {
    console.log('▶ Test 4: seed content + defaults sanity');
    // Company-reported figures keep their framing inside the content.
    assert.ok(seedService.SEED_CONTENT.includes('should be treated as marketing figures, not audited'), 'marketing figures carry the not-audited framing');
    assert.ok(seedService.SEED_CONTENT.includes('sales@sudarshanpipes.com'), 'contact info present');
    assert.ok(seedService.SEED_CONTENT.includes('IS 4984:2016'), 'standards present');

    // Settings route still resolves defaults for a user with nothing stored.
    const settingsRoute = require('../../routes/settings');
    const getHandler = findRoute(settingsRoute, 'get', '/');
    const req = { user: { id: FRESH_USER, email: 'new@sudarshanpipes.com' } };
    let body = null;
    await getHandler(req, { json: (d) => { body = d; }, status() { return { json: (d) => { body = d; } }; } });
    assert.strictEqual(body.email.apiKeySet, false, 'fresh user has no Resend key yet');
    assert.ok(Array.isArray([]) && body.business.name !== undefined, 'settings response shape intact');
    console.log('✅ Test 4 passed\n');
}

async function main() {
    try {
        await test1_freshUserSeeded();
        await test2_existingUserUntouched();
        await test3_deletedSeedNotReSeeded();
        await test4_seedContentFraming();
        console.log('🎉 ALL REBRAND + SEEDING SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ SMOKE TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
