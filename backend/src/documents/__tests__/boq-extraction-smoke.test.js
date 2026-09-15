// =============================================================
// Smoke test — Document Intelligence (BOQ extraction).
//
// Proves, WITHOUT real Supabase or a real AI call:
//   1. XLSX text extraction flattens a real workbook (built with
//      exceljs) into readable pipe-separated rows.
//   2. AI response normalization handles plain JSON, fenced JSON,
//      and prose-wrapped JSON.
//   3. Row flagging catches: missing size, missing/non-numeric/zero
//      quantity, inconsistent units for the same product+size,
//      duplicate line items, and >100x-median outlier quantities.
//   4. Clean rows produce no warnings.
//   5. Storage is tenant-scoped: the PUT review-save path updates
//      only the owner's document; another user gets a 404-style miss.
//
// Run: node backend/src/documents/__tests__/boq-extraction-smoke.test.js
// =============================================================
const assert = require('assert');
const ExcelJS = require('exceljs');

// ── Minimal in-memory Supabase mock injected BEFORE modules load ──
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const state = {
    rows: {
        boq_documents: [
            {
                id: 1, user_id: USER_A, filename: 'boq.xlsx', file_ext: '.xlsx',
                document_text: 'x', status: 'review',
                items: JSON.stringify([{ product: 'HDPE Pipe', size: '110mm', specification: 'PE100', quantity: '500', unit: 'm', application: '', notes: '' }]),
                warnings: JSON.stringify([[]]),
            },
        ],
        app_settings: [],
    },
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
            // getById() chains .select('*').eq(...).eq(...).single()
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

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const boqExtractor = require('../boqExtractor');
const boqRoute = require('../../routes/boq');

async function buildWorkbook(rows) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('BOQ');
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function test1_xlsxTextExtraction() {
    console.log('▶ Test 1: XLSX BOQ flattens to readable rows');
    const buffer = await buildWorkbook([
        ['Item', 'Description', 'Size', 'Qty', 'Unit'],
        ['1', 'HDPE Pipe PE100', '110mm', '500', 'm'],
        ['2', 'HDPE Pipe PE100', '90mm', '250', 'm'],
    ]);
    const text = await boqExtractor.extractText(buffer, '.xlsx');
    assert.ok(text.includes('HDPE Pipe PE100'), 'product text extracted');
    assert.ok(text.includes('110mm'), 'size extracted');
    assert.ok(text.includes('|'), 'cells joined readably');
    console.log('✅ Test 1 passed\n');
}

async function test2_aiResponseNormalization() {
    console.log('▶ Test 2: AI response normalization (plain, fenced, wrapped)');
    const good = '{"items":[{"product":"HDPE Pipe","size":"6 inch","specification":"PE100 PN10","quantity":"500","unit":"m","application":"water supply","notes":""}]}';
    assert.strictEqual(boqExtractor.normalizeResponse(good).length, 1, 'plain JSON parsed');
    assert.strictEqual(boqExtractor.normalizeResponse('```json\n' + good + '\n```').length, 1, 'fenced JSON parsed');
    assert.strictEqual(boqExtractor.normalizeResponse('Here you go:\n' + good + '\nDone.').length, 1, 'prose-wrapped JSON parsed');
    assert.throws(() => boqExtractor.normalizeResponse('no json here at all'), /structured extraction data/, 'garbage rejected');
    console.log('✅ Test 2 passed\n');
}

async function test3_rowFlagging() {
    console.log('▶ Test 3: warning rules catch bad rows');
    const items = [
        { product: 'HDPE Pipe', size: '110mm', specification: 'PE100', quantity: '500', unit: 'm', application: '', notes: '' },
        { product: 'HDPE Pipe', size: '110mm', specification: 'PE100', quantity: '200', unit: 'm', application: '', notes: 'repeat row' },
        { product: 'uPVC Pipe', size: '', specification: 'IS 4985', quantity: '', unit: '', application: '', notes: '' },
        { product: 'Ductile Iron', size: 'DN200', specification: '', quantity: 'abc', unit: 'nos', application: '', notes: '' },
        { product: 'HDPE Pipe', size: '90mm', specification: 'PE100', quantity: '0', unit: 'm', application: '', notes: '' },
        { product: 'GI Pipe', size: '2 inch', specification: '', quantity: '999999', unit: 'm', application: '', notes: '' },
        { product: 'CPVC Pipe', size: '1 inch', specification: '', quantity: '150', unit: 'm', application: '', notes: '' },
    ];
    const warnings = boqExtractor.flagAll(items);
    assert.deepStrictEqual(warnings[0], [], 'clean first row has no warnings');
    assert.ok(warnings[1].some((w) => /Duplicate line item/i.test(w)), 'duplicate flagged');
    assert.ok(warnings[2].some((w) => /Missing size/i.test(w)), 'missing size flagged');
    assert.ok(warnings[2].some((w) => /Missing quantity/i.test(w)), 'missing quantity flagged');
    assert.ok(warnings[3].some((w) => /not a number/i.test(w)), 'non-numeric quantity flagged');
    assert.ok(warnings[4].some((w) => /zero or negative/i.test(w)), 'zero quantity flagged');
    assert.ok(warnings[5].some((w) => /over 100x the document median/i.test(w)), 'outlier quantity flagged');
    assert.deepStrictEqual(warnings[6], [], 'extra normal row stays clean');
    console.log('✅ Test 3 passed\n');
}

async function test4_inconsistentUnits() {
    console.log('▶ Test 4: unit consistency check across same product+size');
    const items = [
        { product: 'HDPE Pipe', size: '110mm', specification: '', quantity: '100', unit: 'm', application: '', notes: '' },
        { product: 'HDPE Pipe', size: '110mm', specification: 'other grade', quantity: '50', unit: 'nos', application: '', notes: '' },
        // Same size, different product → different key, no warning.
        { product: 'uPVC Pipe', size: '110mm', specification: '', quantity: '30', unit: 'nos', application: '', notes: '' },
    ];
    const warnings = boqExtractor.flagAll(items);
    assert.strictEqual(warnings[0].length, 0, 'first row clean');
    assert.ok(warnings[1].some((w) => /Inconsistent unit/i.test(w) && /"m" earlier vs "nos"/.test(w)), 'unit mismatch flagged with details');
    assert.strictEqual(warnings[2].length, 0, 'different product same size is fine');
    console.log('✅ Test 4 passed\n');
}

async function test5_rfqRowsShape() {
    console.log('▶ Test 5: RFQ row building matches the export layout');
    const doc = {
        filename: 'project-x.xlsx',
        items: JSON.stringify([
            { product: 'HDPE Pipe', size: '110mm', specification: 'PE100 PN10', quantity: '500', unit: 'm', application: 'water supply', notes: 'rush' },
        ]),
    };
    const rows = boqRoute.rfqRows(doc);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]['S.No'], 1, 'serial number applied');
    assert.strictEqual(rows[0]['Product'], 'HDPE Pipe');
    assert.strictEqual(rows[0]['Quantity'], '500');
    assert.strictEqual(rows[0]['Unit'], 'm');
    assert.ok(rows[0]['Application / Remarks'].includes('water supply'), 'application carried into remarks');

    const pdf = boqRoute.buildRfqPdf(doc);
    assert.ok(Buffer.isBuffer(pdf), 'PDF built as buffer');
    assert.ok(pdf.slice(0, 5).toString('latin1') === '%PDF-', 'PDF magic header');
    assert.ok(pdf.includes('REQUEST FOR QUOTATION'.slice(0, 8)), 'PDF has title text');
    assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'), 'PDF trailer present');
    console.log('✅ Test 5 passed\n');
}

async function test6_tenantScopedSave() {
    console.log('▶ Test 6: review-save is tenant-scoped (PUT path logic)');
    // Simulate the route's scoping rule directly: db.update where id AND user_id.
    const db = require('../../database/db');
    const items = [{ product: 'HDPE Pipe', size: '160mm', specification: 'PE100', quantity: '300', unit: 'm', application: '', notes: '' }];
    await db.update('boq_documents', {
        items: JSON.stringify(items),
        warnings: JSON.stringify(boqExtractor.flagAll(items)),
        status: 'confirmed',
    }, 'id = ? AND user_id = ?', [1, USER_A]);

    let doc = state.rows.boq_documents.find((r) => r.id === 1);
    assert.strictEqual(doc.status, 'confirmed', 'owner save applied');
    assert.ok(JSON.parse(doc.items)[0].size === '160mm', 'edited rows saved');

    // A different user updating the same id matches nothing.
    const before = JSON.stringify(state.rows.boq_documents);
    await db.update('boq_documents', { status: 'confirmed' }, 'id = ? AND user_id = ?', [1, USER_B]);
    doc = state.rows.boq_documents.find((r) => r.id === 1);
    assert.strictEqual(doc.status, 'confirmed', 'still owner value');
    assert.strictEqual(JSON.stringify(state.rows.boq_documents), before, 'no rows changed for other user');

    // Route lookup scoping: getById with the wrong user returns null.
    const notFound = await db.getById('boq_documents', 1, USER_B);
    assert.strictEqual(notFound, null, 'user B cannot read user A document');
    console.log('✅ Test 6 passed\n');
}

async function main() {
    try {
        await test1_xlsxTextExtraction();
        await test2_aiResponseNormalization();
        await test3_rowFlagging();
        await test4_inconsistentUnits();
        await test5_rfqRowsShape();
        await test6_tenantScopedSave();
        console.log('🎉 ALL BOQ SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
