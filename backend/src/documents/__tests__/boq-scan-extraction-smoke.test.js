// =============================================================
// Smoke test — BOQ table extraction accuracy on the REAL scanned tender.
//
// Fixture: the raw OCR detections of 20260521084851.pdf (DMA MGNVY-2.0
// Package-02, Belagavi; 19 printed pages, printed total Rs 42,85,90,237.37),
// replayed through the same steps as POST /api/boq/process: detections ->
// grouped lines -> positional table reconstruction -> line items -> row
// repair. Expected values are the ones printed in the BOQ.
//
// Run: node backend/src/documents/__tests__/boq-scan-extraction-smoke.test.js
// =============================================================
'use strict';

const assert = require('node:assert/strict');
const fixture = require('./fixtures/belagavi-scan-ocr.json');

// ── Minimal Supabase stand-in for the PUT /api/boq/:id gate ───
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

function extractFromScan() {
    const pages = fixture.pages.map((page) => ({ ...page, rows: groupOcrDetections(page.detections) }));
    const tables = documentModel.reconstructTablesFromLayoutPages(pages);
    const rows = [];
    for (const table of tables) {
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
    return { rows, ...repair.repairExtractedItems(rows, { mergeContinuations: true }) };
}

function testRealScan() {
    const { rows, items, summary } = extractFromScan();
    assert.ok(rows.length >= 115, `the raw reconstruction still has footer/continuation rows (${rows.length})`);
    assert.equal(items.length, 104, 'one row per BOQ item (104 printed items)');

    // Footers, signatures, stamps, blank rows and the total row are dropped.
    const allText = items.map((item) => [item.serialNumber, item.itemCode, item.description, item.unit].join(' ')).join('\n');
    assert.doesNotMatch(allText, /seal and si\w*nature|executive en\w*|page\s*\d*\s*of\s*19|S\.PATIL|total contract amount/i);
    assert.ok(summary.dropped.some((row) => row.reason === 'page footer / signature'));
    assert.ok(summary.dropped.some((row) => row.reason === 'total row'));
    assert.equal(summary.printedTotal, 428590237.37, 'printed total read from the total row');
    assert.equal(typeof summary.difference, 'number', 'sum of amounts vs printed total is reported');
    assert.equal(summary.totalOk, false, 'a few amounts are misread in this scan: the total does not reconcile and says so');

    const bySerial = (serial) => {
        const found = items.filter((item) => item.serialNumber === String(serial));
        assert.equal(found.length, 1, `exactly one item with S.No ${serial}`);
        return found[0];
    };
    const expected = [
        // S.No, code, qty, unit, rate, amount, size
        [72, null, 45398.8, 'm', 470, 21337436, '110 mm'],
        [73, '9.1.9', 22699.4, 'm', 1500, 34049100, '200 mm'],
        [74, '9.16.10', 1700, 'm', 6406, 10890200, '600 mm'],
        [75, '9.16.6', 3462, 'm', 1244, 4306728, '250 mm'],
        [76, '9.16.7', 2368, 'm', 1655, 3919040, '300 mm'],
        [11, '12.2', 459.8, 'm', 263, 120927.4, '110 mm OD'],
        [12, '12.2', 135, 'm', 407, 54945, '100 mm'],
        [13, null, 1156, 'm', 407, 470492, '100 mm'],
        [14, null, 2288, 'm', 640, 1464320, '150 mm'],
        [15, null, 573.75, 'm', 971, 557111.25, '230 mm'],
    ];
    for (const [serial, code, quantity, unit, rate, amount, size] of expected) {
        const item = bySerial(serial);
        assert.equal(item.quantity, quantity, `S.No ${serial} quantity`);
        assert.equal(item.unit, unit, `S.No ${serial} unit`);
        assert.equal(item.rate, rate, `S.No ${serial} rate`);
        assert.equal(item.amount, amount, `S.No ${serial} amount`);
        assert.equal(item.size, size, `S.No ${serial} size`);
        if (code) assert.equal(item.itemCode, code, `S.No ${serial} item code`);
    }
    const hdpe110 = bySerial(72);
    assert.match(hdpe110.specification, /HDPE, PE80, PN 6\.0, IS 4984:2016/);
    assert.ok(hdpe110.corrections.some((entry) => entry.field === 'serialNumber' && entry.original === '77.' && entry.corrected === '72'), 'S.No "77." repaired from the sequence, with the original kept');
    assert.ok(hdpe110.corrections.some((entry) => entry.field === 'size' && entry.corrected === '110 mm' && entry.level === 'warning'), 'OCR "1 10mm" -> 110 mm is flagged');
    assert.ok(hdpe110.checks.some((check) => check.code === 'item_code_suspicious'), 'item code "914" is kept but flagged');
    assert.match(bySerial(74).specification, /DWC HDPE, SN8, IS 16098 Part 2/);
    assert.match(bySerial(75).description, /^Providing and installation of Class SN8 Double Wall Corrugated/, 'first line moved back from the previous row');
    assert.match(hdpe110.rawDescription, /NOTC: Upto 110mm din Coil/, 'raw OCR text is kept');
    assert.ok(bySerial(15).corrections.some((entry) => entry.field === 'amount' && entry.level === 'warning'), 'amount computed from qty x rate is flagged');

    // Lost decimal points: "78,00" read as 7800, "2,00" read as 200.
    const chambers = bySerial(19);
    assert.equal(chambers.quantity, 78);
    const lost = chambers.corrections.find((entry) => entry.field === 'quantity');
    assert.equal(lost.original, '78,00');
    assert.equal(lost.corrected, 78);
    assert.equal(lost.level, 'warning');
    assert.match(lost.reason, /decimal point lost.*7800/);
    const switches = items.find((item) => /Automatic Switch for Street Light/i.test(item.description || ''));
    assert.equal(switches.quantity, 2);
    assert.ok(switches.corrections.some((entry) => entry.field === 'quantity' && entry.original === '2,00'));

    // Units: superscript misreads repaired with context and flagged.
    const refilling = bySerial(1);
    assert.equal(refilling.unit, 'm3');
    assert.ok(refilling.corrections.some((entry) => entry.field === 'unit' && entry.original === 'm²' && entry.corrected === 'm3' && entry.level === 'warning'));
    assert.equal(bySerial(19).unit, 'each', '"cach" normalised to each');

    // Rate taken from the rate in words when the figure is wrong.
    const removal = bySerial(48);
    assert.equal(removal.rate, 93, 'rate in words (Ninety Three) beats the misread figure 95');

    // Every corrected value records original, corrected value and reason.
    for (const item of items) {
        for (const entry of item.corrections) {
            assert.ok('original' in entry && 'corrected' in entry && entry.reason, `S.No ${item.serialNumber} correction is explained`);
        }
        if (item.corrections.some((entry) => entry.level !== 'info') || item.checks.some((check) => check.level !== 'info')) {
            assert.equal(item.needsReview, true);
        }
    }
    const verified = items.filter((item) => item.verified).length;
    assert.ok(verified >= 95, `qty x rate = amount verified on ${verified} of 104 rows`);
    // Every remaining misread is visible, never silent.
    for (const serial of [4, 44, 57, 79]) assert.equal(bySerial(serial).needsReview, true, `S.No ${serial} (misread digits) is flagged`);
    return items;
}

function testNumbersAndWords() {
    const values = (raw) => repair.numberCandidates(raw).map((entry) => entry.value);
    assert.equal(values('45398 80')[0], 45398.8, 'space read for the decimal point');
    assert.equal(values('22699.40 40')[0], 22699.4, 'duplicated trailing fragment');
    assert.deepEqual(values('78,00').slice(0, 2), [78, 7800], 'decimal comma first, grouping second');
    assert.equal(values('1459669. 17')[0], 1459669.17);
    assert.equal(values('13:00')[0], 13);
    assert.equal(values('22 nn')[0], 22);
    assert.equal(values('1464320 D0')[0], 1464320);
    assert.ok(values('$4945 00').includes(54945), '"$" may be a 5');
    assert.equal(values('5 5.00')[0], 5);
    assert.equal(values('73500.00 Rupees Seventy Three Thousand Five Hundred Only')[0], 73500);
    assert.deepEqual(values('ZAR (KKR)'), []);
    assert.equal(repair.wordsToNumber('Rupees Seventy Eight Thousand Three Hundred Twenty Five Only'), 78325);
    assert.equal(repair.wordsToNumber('Rupees Nine Hundred Seventt One Only'), 971, 'OCR typos in the words are tolerated');
    assert.equal(repair.wordsToNumber('Rupees One Lakh(s) Fifty Six Thousand Three Hundred Six Only'), 156306);
    assert.equal(repair.wordsToNumber('Rupees Two Humdred huglity Fight Only'), null, 'unreadable words give no value');
}

function boqRow(cells, extra = {}) {
    const headers = ['S.No', 'Item Code', 'Item Name', 'Unit', 'Estimate Quantity', 'Final Quoted Rate', 'Amount in Words', 'Amount in Rs.'];
    const values = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    return {
        lineItemId: `t:${cells[0]}:${cells[2]}`,
        serialNumber: cells[0] || null,
        itemCode: cells[1] || null,
        description: cells[2] || null,
        unit: cells[3] || null,
        quantity: null,
        sourceValues: values,
        provenance: { page: extra.page || 1, row: extra.row || 1, columns: { serialNumber: 'S.No', itemCode: 'Item Code', description: 'Item Name', unit: 'Unit', quantity: 'Estimate Quantity' } },
        warnings: [],
    };
}

function testSyntheticRepairs() {
    const { items, summary } = repair.repairExtractedItems([
        boqRow(['20', '16.40.2', 'Providing and constructing of Machinehole chambers', 'each', '7800', '78325.00', 'Rupees Seventy Eight Thousand Three Hundred Twenty Five Only', '6109350.00']),
        boqRow(['21', '16.40.3', 'Providing and constructing of Machinehole chambers deeper', 'each', '', '1005.00', 'Rupees One Thousand Five Only', '51255.00']),
        boqRow(['', '', 'Seal and Signature of Contractor', '', '', '', 'The Executive Engineer, DMA', '']),
        boqRow(['', '', '', 'Page 3 of 19', '', '', '', '']),
        boqRow(['', '', '', '', '', '', '', '']),
        boqRow(['22', '16.46.1', 'Earth work excavation for foundation', 'm²', '10.00', '100.00', '', '1000.00']),
        boqRow(['', 'Item No.16.46.1 (a)', 'in all kinds of soil', '', '', '', '', '']),
        boqRow(['79 PWD SR V5 Page No. 201', '', 'Providing machinehole repairs', 'Each', '3.00', '100.00', '', '300.00']),
    ], {});
    assert.equal(items.length, 4, 'footer, page number and blank rows are dropped; the continuation row is merged');
    assert.equal(summary.dropped.length, 3);
    const [first, second, third, fourth] = items;
    // Lost decimal (7800 vs 78.00 at rate 78325) is flagged and corrected from amount / rate.
    assert.equal(first.quantity, 78);
    const decimal = first.corrections.find((entry) => entry.field === 'quantity');
    assert.equal(decimal.original, '7800');
    assert.equal(decimal.corrected, 78);
    assert.match(decimal.reason, /decimal point lost/);
    assert.equal(first.needsReview, true);
    // Missing quantity recovered from amount / rate.
    assert.equal(second.quantity, 51);
    assert.match(second.corrections.find((entry) => entry.field === 'quantity').reason, /recovered from amount ÷ rate = 51, verify/);
    // S.No and Item Code are the BOQ's own.
    assert.deepEqual(items.map((item) => item.serialNumber), ['20', '21', '22', '79']);
    assert.deepEqual(items.map((item) => item.itemCode), ['16.40.2', '16.40.3', '16.46.1 Item No.16.46.1 (a)', 'PWD SR V5 Page No. 201']);
    assert.match(third.description, /excavation for foundation in all kinds of soil$/, 'continuation text merged into its item');
    assert.equal(third.unit, 'm3', 'excavation billed in m² is a superscript misread');
    assert.equal(fourth.unit, 'each');

    // Native Excel/Word tables keep heading rows (no continuation merging).
    const native = repair.repairExtractedItems([
        boqRow(['', '', 'EARTHWORK', '', '', '', '', '']),
        boqRow(['1', '1.1', 'Excavation', 'm3', '10', '5', '', '50']),
    ], { mergeContinuations: false });
    assert.equal(native.items.length, 2);

    // Lists without rate/amount columns are not "unverified" everywhere.
    const list = repair.repairExtractedItems([{ description: 'HDPE pipe 110 mm PE100 PN10', quantity: '120', unit: 'm', sourceValues: {}, provenance: {} }], {});
    assert.equal(list.items[0].quantity, 120);
    assert.equal(list.items[0].needsReview, false);
    assert.equal(list.items[0].size, '110 mm', 'size extracted from the description');
}

async function testConfirmationGate(items) {
    const boqRoute = require('../../routes/boq');
    const USER = '11111111-1111-1111-1111-111111111111';
    tables.boq_documents.push({ id: 7, user_id: USER, filename: 'scan.pdf', status: 'review', items: JSON.stringify(items), warnings: '[]', extraction_metadata: {} });
    const layer = boqRoute.router.stack.find((entry) => entry.route?.path === '/:id' && entry.route.methods.put);
    const call = async (body) => {
        const response = {};
        const res = { status(code) { response.status = code; return res; }, json(payload) { response.body = payload; return res; } };
        await layer.route.stack[0].handle({ params: { id: '7' }, user: { id: USER }, body }, res);
        return { status: response.status || 200, body: response.body };
    };
    let response = await call({ items, status: 'confirmed' });
    assert.equal(response.status, 409, 'flagged rows block confirmation');
    assert.match(response.body.error, /flagged row\(s\) must be reviewed/);
    const flagged = items.filter((item) => item.needsReview).length;
    assert.equal(response.body.unreviewed.length, flagged);

    const reviewed = items.map((item) => ({ ...item, reviewConfirmed: item.needsReview ? true : item.reviewConfirmed }));
    response = await call({ items: reviewed, status: 'confirmed' });
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
    assert.equal(response.body.status, 'confirmed');

    // Changing a confirmed row's numbers withdraws its confirmation.
    const edited = response.body.items.map((item) => (item.serialNumber === '19' ? { ...item, quantity: 80 } : item));
    response = await call({ items: edited, status: 'confirmed' });
    assert.equal(response.status, 409, 'an edited flagged row must be reviewed again');
    const row19 = edited.findIndex((item) => item.serialNumber === '19');
    assert.ok(response.body.unreviewed.includes(row19));
}

async function main() {
    testNumbersAndWords();
    testSyntheticRepairs();
    const items = testRealScan();
    await testConfirmationGate(items);
    console.log('boq-scan-extraction-smoke.test.js passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
