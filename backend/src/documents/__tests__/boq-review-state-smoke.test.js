// =============================================================
// Smoke test — BOQ review state (severity, acceptance, confirmation gate).
//
// 1. The REAL scanned tender (fixture: 20260521084851.pdf OCR detections):
//    the four rows with genuinely wrong numbers come out "error", the pipe
//    lines whose repairs are confirmed come out "ok".
// 2. Rules on small synthetic BOQs: AI-timeout-only rows are "glance";
//    wrong numbers block confirmation until fixed or accepted with a
//    reason; bulk accept takes "glance" rows only; acceptance is stamped by
//    the server and withdrawn when the numbers change.
//
// Run: node backend/src/documents/__tests__/boq-review-state-smoke.test.js
// =============================================================
'use strict';

const assert = require('node:assert/strict');
const fixture = require('./fixtures/belagavi-scan-ocr.json');

// ── Minimal Supabase stand-in for the BOQ routes ──────────────
const tables = { boq_documents: [] };
function from(table) {
    const state = { filters: [], payload: null, op: 'select' };
    const match = (row) => state.filters.every(([column, value]) => String(row[column]) === String(value));
    const api = {
        select() { return api; },
        eq(column, value) { state.filters.push([column, value]); return api; },
        update(payload) { state.op = 'update'; state.payload = payload; return api; },
        async single() {
            const row = tables[table].find(match);
            return row ? { data: { ...row }, error: null } : { data: null, error: { code: 'PGRST116' } };
        },
        then(resolve, reject) {
            if (state.op === 'update') {
                for (const row of tables[table].filter(match)) Object.assign(row, state.payload);
            }
            return Promise.resolve({ data: tables[table].filter(match).map((row) => ({ ...row })), error: null }).then(resolve, reject);
        },
    };
    return api;
}
const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: { supabase: { from }, isAvailable: () => true, transaction: async () => {}, normalizeRow: (row) => row, parseJsonFields: (row) => row },
};

const documentModel = require('../documentModel');
const { groupOcrDetections } = require('../pdfOcr');
const repair = require('../boqRowRepair');
const reviewState = require('../boqReviewState');
const boqRoute = require('../../routes/boq');

const USER = '22222222-2222-2222-2222-222222222222';
const ACTOR = { id: USER, email: 'checker@example.com' };

function realScanItems() {
    const pages = fixture.pages.map((page) => ({ ...page, rows: groupOcrDetections(page.detections) }));
    const rows = [];
    for (const table of documentModel.reconstructTablesFromLayoutPages(pages)) {
        for (const row of table.rows) {
            rows.push(documentModel.mergeDerivedFields(documentModel.lineItemFromRow({
                headers: table.headers,
                row: row.cells,
                source: row.source || table.source,
                filename: '20260521084851.pdf',
                headerMap: { columns: table.columnMap || documentModel.mapHeaders(table.headers).columns, ambiguous: table.ambiguousHeaders || {} },
            }), {}));
        }
    }
    return repair.repairExtractedItems(rows, { mergeContinuations: true }).items;
}

function testRealScanSeverity() {
    const items = reviewState.annotateItems(realScanItems());
    const bySerial = (serial) => {
        const found = items.filter((item) => item.serialNumber === String(serial));
        assert.equal(found.length, 1, `exactly one item with S.No ${serial}`);
        return found[0];
    };
    // The known misreads are caught as wrong numbers, with the right reason.
    for (const serial of [4, 44, 57, 79]) assert.equal(bySerial(serial).severity, 'error', `S.No ${serial} has wrong numbers`);
    assert.equal(bySerial(4).reviewNotes.find((note) => note.severity === 'error').code, 'rate_amount_missing', 'S.No 4: rate and amount unreadable');
    const mismatch44 = bySerial(44).reviewNotes.find((note) => note.code === 'amount_mismatch');
    assert.equal(mismatch44.computed, 312550.68);
    assert.equal(mismatch44.amount, 313550.68);
    assert.equal(mismatch44.difference, 1000, 'S.No 44 amount is off by 1,000');
    assert.equal(bySerial(57).reviewNotes.find((note) => note.code === 'amount_mismatch').quantity, 2571.29);
    assert.equal(bySerial(79).reviewNotes.find((note) => note.code === 'amount_mismatch').difference, -50000, 'S.No 79 amount is off by 50,000');
    // Only those four are errors in this scan.
    assert.deepEqual(items.filter((item) => item.severity === 'error').map((item) => item.serialNumber), ['4', '44', '57', '79']);

    // Pipe and stoneware lines whose repairs are confirmed are OK: S.No from
    // the sequence, "m" for a pipe, 1 10mm -> 110 mm, numbers verified, and
    // S.No 15's blank amount rebuilt from qty x rate (rate confirmed in words).
    for (const serial of [11, 12, 13, 14, 15, 73, 74, 75, 76]) {
        const item = bySerial(serial);
        assert.equal(item.severity, 'ok', `S.No ${serial} is OK (${JSON.stringify(item.reviewNotes)})`);
        assert.equal(item.forQuotation, true, `S.No ${serial} goes to the quotation`);
    }
    // S.No 72 is a correct pipe line too, but its item code reads "914"
    // (probably 9.1.4): never an error, a quick glance for the code only.
    const row72 = bySerial(72);
    assert.equal(row72.severity, 'glance');
    assert.deepEqual(row72.reviewNotes.map((note) => note.code), ['code_unclear']);
    assert.equal(row72.forQuotation, true);
    // Corrections stay recorded even when the row is OK.
    assert.ok(bySerial(11).corrections.some((entry) => entry.field === 'serialNumber'));

    const counts = reviewState.reviewCounts(items);
    assert.equal(counts.total, 104);
    assert.equal(counts.error, 4);
    assert.equal(counts.error + counts.glance + counts.ok, 104);
    assert.ok(counts.ok > counts.glance, `most rows are fine (${counts.ok} OK, ${counts.glance} glance)`);
    return items;
}

// ── Synthetic rows ────────────────────────────────────────────
function row(id, fields = {}, extra = {}) {
    const value = (field, fallback) => (field in fields ? fields[field] : fallback);
    return {
        lineItemId: `syn:${id}`,
        serialNumber: String(id),
        description: fields.description || 'Earth work excavation in all kinds of soil',
        quantity: value('quantity', 10),
        unit: value('unit', 'm3'),
        rate: value('rate', 100),
        amount: value('amount', 1000),
        ocr: { quantity: '10', unit: 'm3', rate: '100', amount: '1000', words: '' },
        corrections: [],
        checks: [],
        warnings: [],
        provenance: { page: 1 },
        ...extra,
    };
}

function testRules() {
    // AI step timed out, numbers fine: a glance, never an error.
    const aiOnly = reviewState.annotateItems([row(1, {}, { warnings: ['AI batch review required: Section 2 of 3 of "scan.pdf" returned malformed or untrusted AI output; this batch was marked for review instead of failing the entire BOQ: The shared AI extraction deadline expired.'] })])[0];
    assert.equal(aiOnly.severity, 'glance');
    assert.deepEqual(aiOnly.reviewNotes.map((note) => note.code), ['ai_timeout']);
    const unmatched = reviewState.annotateItems([row(2, {}, { warnings: ['AI enrichment could not be matched to this source row.'] })])[0];
    assert.equal(unmatched.severity, 'glance');

    // Number problems are errors.
    const cases = [
        [{ amount: 1200 }, 'amount_mismatch'],
        [{ quantity: null }, 'quantity_missing'],
        [{ rate: null, amount: null }, 'rate_amount_missing'],
        [{ amount: null }, 'amount_missing'],
        [{ quantity: -5, amount: -500 }, 'quantity_impossible'],
    ];
    for (const [fields, code] of cases) {
        const annotated = reviewState.annotateItems([row(3, fields), row(4)])[0];
        assert.equal(annotated.severity, 'error', code);
        assert.equal(annotated.reviewNotes[0].code, code);
    }
    // Within Rs 1 is consistent.
    assert.equal(reviewState.annotateItems([row(5, { amount: 1000.6 })])[0].severity, 'ok');

    // A unit guessed for a non-pipe item is a glance; "m" for a pipe is not.
    const guessedUnit = { field: 'unit', original: '(blank)', corrected: 'm3', reason: 'unit missing in OCR; inferred "m3" from the description, verify', level: 'warning' };
    assert.equal(reviewState.annotateItems([row(6, {}, { corrections: [guessedUnit] })])[0].severity, 'glance');
    const pipeUnit = { field: 'unit', original: '(blank)', corrected: 'm', reason: 'unit missing in OCR; inferred "m" from the description, verify', level: 'warning' };
    const pipe = reviewState.annotateItems([row(7, { description: 'Supplying and laying HDPE pipe PE100 PN10 110 mm', unit: 'm' }, { corrections: [pipeUnit] })])[0];
    assert.equal(pipe.severity, 'ok');
    assert.equal(pipe.forQuotation, true);
    // A unit the person changed afterwards is no longer a guess.
    assert.equal(reviewState.annotateItems([row(8, { unit: 'm2' }, { corrections: [guessedUnit] })])[0].severity, 'ok');
}

// ── Route-level gate ──────────────────────────────────────────
function handler(path, method) {
    const layer = boqRoute.router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
    return async (id, body, user = ACTOR) => {
        const response = {};
        const res = { status(code) { response.status = code; return res; }, json(payload) { response.body = payload; return res; }, set() { return res; } };
        await layer.route.stack[0].handle({ params: { id: String(id) }, user, body }, res);
        return { status: response.status || 200, body: response.body };
    };
}
const put = handler('/:id', 'put');
const accept = handler('/:id/accept', 'post');
const get = handler('/:id', 'get');

function storeDoc(id, items) {
    tables.boq_documents.push({ id, user_id: USER, filename: `doc-${id}.pdf`, status: 'review', items: JSON.stringify(items), warnings: '[]', extraction_metadata: {} });
}

async function testGate() {
    // An error row blocks confirmation.
    storeDoc(11, [row(1), row(2, { amount: 1500 }), row(3)]);
    let response = await put(11, { items: (await get(11)).body.items, status: 'confirmed' });
    assert.equal(response.status, 409, 'wrong numbers block confirmation');
    assert.match(response.body.error, /^1 item still has wrong numbers \(S\.No 2\)/);
    assert.deepEqual(response.body.blocking, [1]);

    // Fixing the numbers clears it, and records who fixed it.
    const items = (await get(11)).body.items;
    items[1] = { ...items[1], amount: 1000 };
    response = await put(11, { items, status: 'confirmed' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'confirmed');
    assert.equal(response.body.items[1].severity, 'ok');
    assert.equal(response.body.items[1].initialSeverity, 'error', 'the original severity is remembered ("Fixed by me")');
    assert.equal(response.body.items[1].fixed.by, 'checker@example.com');
    assert.ok(response.body.items[1].fixed.at);

    // Explicit accept (one row, with a reason) clears it.
    storeDoc(12, [row(1), row(2, { amount: 1500 })]);
    response = await accept(12, { rows: ['syn:2'] });
    assert.equal(response.status, 400, 'a wrong-numbers row needs a reason');
    assert.match(response.body.error, /Say why/);
    response = await accept(12, { rows: [{ lineItemId: 'syn:2', reason: 'Matches the printed BOQ' }] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const accepted = response.body.items[1];
    assert.equal(accepted.severity, 'error');
    assert.deepEqual([accepted.acceptance.by, accepted.acceptance.reason, accepted.acceptance.severity], ['checker@example.com', 'Matches the printed BOQ', 'error']);
    assert.ok(Date.parse(accepted.acceptance.at));
    response = await put(12, { items: response.body.items, status: 'confirmed' });
    assert.equal(response.status, 200, 'an accepted error row no longer blocks');

    // Acceptance cannot be forged by the client, and changing the numbers withdraws it.
    storeDoc(13, [row(1, { amount: 1500 })]);
    const forged = (await get(13)).body.items.map((item) => ({ ...item, acceptance: { by: 'someone', at: new Date().toISOString(), reason: 'trust me' }, reviewConfirmed: true }));
    response = await put(13, { items: forged, status: 'confirmed' });
    assert.equal(response.status, 409, 'client-sent acceptance is ignored');
    response = await accept(13, { rows: [{ lineItemId: 'syn:1', reason: 'Checked on the scan' }] });
    const changed = response.body.items.map((item) => ({ ...item, amount: 1600 }));
    response = await put(13, { items: changed, status: 'confirmed' });
    assert.equal(response.status, 409, 'new numbers need a new decision');

    // Bulk accept of "glance" rows; an amber-only BOQ confirms afterwards.
    const timeout = ['AI batch review required: The shared AI extraction deadline expired.'];
    storeDoc(14, [row(1, {}, { warnings: timeout }), row(2, {}, { warnings: timeout }), row(3)]);
    let doc = (await get(14)).body;
    assert.deepEqual(doc.items.map((item) => item.severity), ['glance', 'glance', 'ok']);
    assert.equal(doc.review.glance, 2);
    response = await accept(14, { rows: ['syn:1', 'syn:2'], reason: 'Looks fine' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.review.glance, 0);
    assert.equal(response.body.review.accepted, 2);
    assert.ok(response.body.items.slice(0, 2).every((item) => item.acceptance.by === 'checker@example.com'));
    response = await put(14, { items: response.body.items, status: 'confirmed' });
    assert.equal(response.status, 200);
    assert.ok(response.body.items.slice(0, 2).every((item) => item.acceptance), 'acceptance survives a save without number changes');

    // The server rejects a bulk accept that includes an error row - and accepts nothing.
    storeDoc(15, [row(1, {}, { warnings: timeout }), row(2, { amount: 1500 })]);
    response = await accept(15, { rows: ['syn:1', 'syn:2'], reason: 'Looks fine' });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /wrong numbers/);
    assert.deepEqual(response.body.errorRows, [1]);
    doc = (await get(15)).body;
    assert.equal(doc.items[0].acceptance, null, 'nothing was accepted');
    response = await accept(15, { rows: ['syn:2'], bulk: true, reason: 'Looks fine' });
    assert.equal(response.status, 409, 'bulk: true with a single error row is rejected too');

    // Undo: an acceptance can be withdrawn, and undoing an edit back to the
    // original values clears "fixed by".
    response = await accept(15, { rows: ['syn:1'] });
    assert.ok(response.body.items[0].acceptance);
    response = await put(15, { items: response.body.items, unaccept: ['syn:1'] });
    assert.equal(response.status, 200);
    assert.equal(response.body.items[0].acceptance, null, 'Undo withdrew "Looks fine"');
    const original = response.body.items;
    response = await put(15, { items: original.map((item, index) => (index === 1 ? { ...item, amount: 1000 } : item)) });
    assert.equal(response.body.items[1].severity, 'ok');
    assert.deepEqual(response.body.items[1].fixed.original, { quantity: 10, rate: 100, amount: 1500, unit: 'm3' });
    response = await put(15, { items: original });
    assert.equal(response.body.items[1].fixed, null, 'back to the original values: no longer "fixed by me"');
    assert.equal(response.body.items[1].severity, 'error');
}

async function main() {
    testRealScanSeverity();
    testRules();
    await testGate();
    console.log('boq-review-state-smoke.test.js passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
