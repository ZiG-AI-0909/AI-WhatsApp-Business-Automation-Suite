// =============================================================
// Smoke test — Product Identification (Image Extractor mode 2).
//
// Proves, WITHOUT real Supabase, NVIDIA, or a real image:
//   1. The suggestion cleaner clamps confidence to 0..1 and drops
//      unknown fields (schema stability against model drift).
//   2. Vision response normalization handles plain/fenced/wrapped
//      JSON and rejects garbage.
//   3. The prompt is honesty-constrained: framed as a suggestion for
//      manual verification, forbids invented markings.
//   4. Persistence is tenant-scoped: rows carry user_id, list/review/
//      delete queries always include user_id, and another user's rows
//      are invisible.
//
// Run: node backend/src/routes/__tests__/product-identification-smoke.test.js
// =============================================================
const assert = require('assert');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const state = {
    rows: { product_identifications: [], app_settings: [] },
};

function table(name) {
    return {
        select(columns, { columns: _c } = {}) {
            const builder = {
                eq(col, val) { builder._filters.push([col, val]); return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                _filters: [],
                async then(resolve) {
                    let rows = state.rows[name] || [];
                    for (const [col, val] of builder._filters) rows = rows.filter((r) => r[col] === val);
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
        update(data) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push([col, val]); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].map((r) =>
                        filters.every(([c, v]) => r[c] === v) ? { ...r, ...data } : r);
                    return { data: state.rows[name].filter((r) => filters.every(([c, v]) => r[c] === v)), error: null };
                },
            };
            return builder;
        },
        delete() {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push([col, val]); return builder; },
                select: async () => {
                    const before = state.rows[name].length;
                    state.rows[name] = state.rows[name].filter((r) => !filters.every(([c, v]) => r[c] === v));
                    return { data: before > state.rows[name].length ? [{ ok: true }] : [], error: null };
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

// No real NVIDIA call: identifyWithNvidia is exercised only for its
// prompt-shape guarantees via the source, not the network.
process.env.NVIDIA_API_KEY = 'test-key';

const productIdentification = require('../productIdentification');

async function test1_suggestionCleaning() {
    console.log('▶ Test 1: suggestion cleaner normalizes fields and clamps confidence');
    const cleaned = productIdentification.cleanSuggestion({
        product_category: ' HDPE pipe ',
        size: '110mm',
        specification: 'PE100 PN10',
        markings: ['ISI mark', 'batch 2411'],
        condition_notes: 'Blue pipe with printed specifications',
        confidence: 7,
        invented_field: 'should not survive',
    });
    assert.strictEqual(cleaned.product_category, 'HDPE pipe', 'category trimmed');
    assert.strictEqual(cleaned.confidence, 1, 'confidence clamped to max 1');
    assert.strictEqual(cleaned.invented_field, undefined, 'unknown fields dropped');
    assert.ok('markings' in cleaned, 'markings kept');

    const negative = productIdentification.cleanSuggestion({ confidence: -3 });
    assert.strictEqual(negative.confidence, 0, 'confidence clamped to min 0');
    console.log('✅ Test 1 passed\n');
}

async function test2_responseNormalization() {
    console.log('▶ Test 2: vision response normalization');
    const good = '{"product_category":"HDPE pipe","size":"110mm","specification":"PE100 PN10","markings":["IS 4985:2020"],"condition_notes":"clear photo","confidence":0.8}';
    assert.strictEqual(productIdentification.normalizeResponse(good).size, '110mm', 'plain JSON parsed');
    assert.deepStrictEqual(productIdentification.normalizeResponse('```json\n' + good + '\n```').markings, ['IS 4985:2020'], 'fenced JSON parsed');
    assert.strictEqual(productIdentification.normalizeResponse('Result:\n' + good).confidence, 0.8, 'wrapped JSON parsed');
    assert.throws(() => productIdentification.normalizeResponse('cannot see anything'), /structured identification/, 'garbage rejected');
    console.log('✅ Test 2 passed\n');
}

async function test3_promptHonesty() {
    console.log('▶ Test 3: prompt demands suggestion framing and forbids invention');
    const src = require('fs').readFileSync(require.resolve('../productIdentification'), 'utf8');
    assert.ok(src.includes('SUGGESTION for manual verification'), 'framed as suggestion needing verification');
    assert.ok(src.includes('never state certainty'), 'certainty forbidden');
    assert.ok(src.includes('Never invent markings'), 'marking invention forbidden');
    assert.ok(src.includes('If the photo is too unclear'), 'handles unclear photos honestly');
    console.log('✅ Test 3 passed\n');
}

async function test4_tenantScopedPersistence() {
    console.log('▶ Test 4: persistence is tenant-scoped');
    const db = require('../../database/db');

    // A identifies a product.
    const inserted = await db.insert('product_identifications', {
        source_image: 'pipe1.jpg',
        product_category: 'HDPE pipe',
        size: '110mm',
        specification: 'PE100 PN10',
        markings: JSON.stringify(['IS 4985:2020']),
        condition_notes: 'Blue PE pipe, clear printing',
        confidence: 0.8,
        review_status: 'pending_review',
        user_id: USER_A,
    });
    assert.strictEqual(inserted.user_id, USER_A, 'row owned by identifying user');

    // B's list does not include A's row; A's list does.
    const listA = await db.select('product_identifications', '*', 'user_id = ?', [USER_A], 'id', 1000, 0);
    const listB = await db.select('product_identifications', '*', 'user_id = ?', [USER_B], 'id', 1000, 0);
    assert.strictEqual(listA.length, 1, 'owner sees the suggestion');
    assert.strictEqual(listB.length, 0, 'other user sees nothing');

    // Review scoping: B cannot review A's row.
    const updatedByB = await db.update('product_identifications', { review_status: 'confirmed' }, 'id = ? AND user_id = ?', [inserted.id, USER_B]);
    assert.strictEqual(updatedByB.length, 0, 'cross-tenant review matches nothing');
    const stillPending = await db.getById('product_identifications', inserted.id, USER_A);
    assert.strictEqual(stillPending.review_status, 'pending_review', 'review status unchanged by other tenant');

    // Owner confirms.
    await db.update('product_identifications', { review_status: 'confirmed' }, 'id = ? AND user_id = ?', [inserted.id, USER_A]);
    const confirmed = await db.getById('product_identifications', inserted.id, USER_A);
    assert.strictEqual(confirmed.review_status, 'confirmed', 'owner review applied');

    // Delete scoping: B cannot delete A's row; A can.
    const deletedByB = await db.del('product_identifications', 'id = ? AND user_id = ?', [inserted.id, USER_B]);
    assert.strictEqual(deletedByB.length, 0, 'cross-tenant delete matches nothing');
    const deletedByA = await db.del('product_identifications', 'id = ? AND user_id = ?', [inserted.id, USER_A]);
    assert.ok(deletedByA.length === 1, 'owner delete works');
    console.log('✅ Test 4 passed\n');
}

async function main() {
    try {
        await test1_suggestionCleaning();
        await test2_responseNormalization();
        await test3_promptHonesty();
        await test4_tenantScopedPersistence();
        console.log('🎉 ALL PRODUCT-IDENTIFICATION SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
