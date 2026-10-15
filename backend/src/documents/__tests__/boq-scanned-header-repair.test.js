// Regression: scanned multi-page tender tables where OCR reads each page's
// header differently (dropped "Unit", garbled "Item Name", lost "S.No.") and
// the tall, vertically-centred rows put description text on separate visual
// lines above/below the line carrying the values. Previously every column to
// the right of a missing header shifted by one (unit landed in quantity,
// quantity in rate) and description fragments / page footers became bogus rows.
const assert = require('node:assert/strict');
const documentModel = require('../documentModel');
const { groupOcrDetections } = require('../pdfOcr');

// Normalised 0..1 coordinates, like the NVIDIA OCR response.
function cell(text, left, right, top, bottom) {
    return {
        text,
        confidence: 0.98,
        boundingBox: { points: [
            { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
        ] },
    };
}

// Column x-extents of the header texts (centred over each column).
const COL = {
    sno: [0.045, 0.073], code: [0.092, 0.150], name: [0.324, 0.384], unit: [0.545, 0.575],
    qty: [0.628, 0.678], rate: [0.703, 0.781], words: [0.789, 0.891], amount: [0.905, 0.955],
};

const FULL_HEADER = (y) => [
    cell('SNo.', ...COL.sno, y, y + 0.008), cell('Item Code', ...COL.code, y, y + 0.008),
    cell('Item Name', ...COL.name, y, y + 0.008), cell('Unit', ...COL.unit, y, y + 0.008),
    cell('Estimate Quantity', ...COL.qty, y - 0.006, y + 0.014), cell('After Negotiation Final Quoted Rate in Figure', ...COL.rate, y - 0.016, y + 0.024),
    cell('Amount in Words', ...COL.words, y, y + 0.008), cell('Amount in Rs.', ...COL.amount, y, y + 0.008),
];
// Page 2 header as OCR really returned it: no "Unit", no "S.No.", "Item Name" garbled.
const BROKEN_HEADER = (y) => [
    cell('Item Code', ...COL.code, y, y + 0.008), cell('Hlmm Name', ...COL.name, y, y + 0.008),
    cell('Estimate Quantity', ...COL.qty, y - 0.006, y + 0.014), cell('After Negotiation Final Quoted Rate in Figure', ...COL.rate, y - 0.016, y + 0.024),
    cell('Amount it Words', ...COL.words, y, y + 0.008), cell('Amount Rs.', ...COL.amount, y, y + 0.008),
];

// A tall row: description paragraph spans [top, bottom]; values sit at its middle.
function tallRow({ serial, code, heading, body, unit, qty, rate, words, amount }, top, bottom) {
    const mid = (top + bottom) / 2;
    return [
        ...(heading ? [cell(heading, 0.155, 0.255, top, top + 0.008)] : []),
        cell(body, 0.155, 0.49, top + 0.012, bottom),
        cell(String(serial), 0.045, 0.06, mid, mid + 0.008),
        cell(code, 0.092, 0.13, mid, mid + 0.008),
        cell(unit, 0.545, 0.565, mid, mid + 0.008),
        cell(qty, 0.628, 0.672, mid, mid + 0.008),
        cell(rate, 0.703, 0.745, mid, mid + 0.008),
        cell(words, 0.789, 0.88, mid, mid + 0.008),
        cell(amount, 0.905, 0.95, mid, mid + 0.008),
    ];
}
const FOOTER = (y) => [
    cell('CLASS. CIVIL CONTRACTOR', 0.02, 0.2, y, y + 0.01),
    cell('Seal and Singnature of Contractor', 0.02, 0.2, y + 0.02, y + 0.03),
    cell('Page 1 of 19', 0.45, 0.5, y + 0.02, y + 0.03),
];

function page(number, detections) {
    return { page: number, width: 1, height: 1, rows: groupOcrDetections(detections) };
}

const pages = [
    // Page 1: complete header, two tall rows (second has a heading line above its values).
    page(1, [
        ...FULL_HEADER(0.06),
        ...tallRow({ serial: 1, code: '1.10', body: 'Refilling available earth around trenches in layers not exceeding 20 cms in depth compacting each layer', unit: 'm³', qty: '28503.23', rate: '176.00', words: 'Rupees One Hundred Seventy Six Only', amount: '5016568.48' }, 0.12, 0.2),
        ...tallRow({ serial: 2, code: '1.12', heading: 'Mechanical Means -', body: 'Earth work in surface excavation by mechanical means for lowering and levelling the ground for all works', unit: 'm³', qty: '14452.17', rate: '101.00', words: 'Rupees One Hundred One Only', amount: '1459669.17' }, 0.22, 0.34),
        ...FOOTER(0.95),
    ]),
    // Page 2: the broken header; rows must still land in the right columns.
    page(2, [
        ...BROKEN_HEADER(0.06),
        ...tallRow({ serial: 3, code: '1.14.1', heading: 'Mechanical Means -', body: 'Earth work excavation for Foundation by mechanical means for all works and depth upto 3 m as per drawing', unit: 'm³', qty: '33930.92', rate: '112.00', words: 'Rupees One Hundred Twelve Only', amount: '3800263.04' }, 0.12, 0.26),
        ...tallRow({ serial: 4, code: '1.17.1', body: 'Earth work excavation for pipeline trenches by mechanical means as per drawing and technical specifications', unit: 'm³', qty: '5171.94', rate: '288.00', words: 'Rupees Two Hundred Eighty Eight Only', amount: '1489518.72' }, 0.28, 0.4),
        ...FOOTER(0.95),
    ]),
];

const tables = documentModel.reconstructTablesFromLayoutPages(pages);
assert.equal(tables.length, 1, 'incomplete page headers are repaired so the table is one continuous table');
const [table] = tables;
assert.deepEqual(
    table.headers,
    ['SNo.', 'Item Code', 'Item Name', 'Unit', 'Estimate Quantity', 'After Negotiation Final Quoted Rate in Figure', 'Amount in Words', 'Amount in Rs.'],
    'missing/garbled headers are restored from the most complete page header',
);
assert.equal(table.rows.length, 4, 'one row per item: heading lines attach to their row, page footers are not rows');

const bySerial = new Map(table.rows.map((row) => [row.cells[0], row]));
const expected = [
    ['1', '1.10', 'm³', '28503.23', '176.00', '5016568.48'],
    ['2', '1.12', 'm³', '14452.17', '101.00', '1459669.17'],
    ['3', '1.14.1', 'm³', '33930.92', '112.00', '3800263.04'],   // page 2: header lacked Unit/S.No.
    ['4', '1.17.1', 'm³', '5171.94', '288.00', '1489518.72'],
];
for (const [serial, code, unit, qty, rate, amount] of expected) {
    const row = bySerial.get(serial);
    assert.ok(row, `row ${serial} exists`);
    assert.equal(row.cells[1], code, `row ${serial} item code`);
    assert.equal(row.cells[3], unit, `row ${serial} unit is in the Unit column, not Quantity`);
    assert.equal(row.cells[4], qty, `row ${serial} quantity`);
    assert.equal(row.cells[5], rate, `row ${serial} rate`);
    assert.equal(row.cells[7], amount, `row ${serial} amount`);
}
assert.match(bySerial.get('2').cells[2], /^Mechanical Means -.*Earth work in surface excavation/, 'heading above the values joins the description of its own row, in reading order');
assert.match(bySerial.get('3').cells[2], /^Mechanical Means -.*Foundation/, 'heading attaches to the following row on the repaired page too');
assert.ok(!bySerial.get('1').cells[2].includes('Mechanical Means'), 'heading belonging to row 2 does not leak into row 1');
assert.ok(table.rows.every((row) => !/Seal|Singnature|Page 1 of/i.test(row.cells.join(' '))), 'page furniture never becomes item data');

// A different table must NOT be "repaired" into the reference layout.
const other = documentModel.reconstructTablesFromLayoutPages([
    pages[0],
    page(2, [
        cell('Item Code', 0.30, 0.38, 0.06, 0.07), cell('Quantity', 0.60, 0.68, 0.06, 0.07),
        cell('9.1', 0.30, 0.34, 0.1, 0.11), cell('4', 0.60, 0.62, 0.1, 0.11),
    ]),
]);
assert.ok(other.every((t) => t.headers.length <= 8));
assert.ok(other.some((t) => t.headers.join('|') === 'Item Code|Quantity'),
    'a header whose columns do not line up with the reference is left untouched');

console.log('✅ Scanned-table header repair + fragment attachment tests passed.');
