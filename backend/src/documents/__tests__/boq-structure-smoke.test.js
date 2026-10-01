const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const boqExtractor = require('../boqExtractor');
const documentModel = require('../documentModel');
const pdfOcr = require('../pdfOcr');
const { groupOcrDetections } = pdfOcr;

async function makeXlsx(headers, rows) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Tender');
    sheet.addRow(headers);
    rows.forEach((row) => sheet.addRow(row));
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

function layoutCell(text, left, y, scale = 1) {
    const width = Math.max(4, String(text).length * 4 * scale);
    return {
        text: String(text),
        boundingBox: { points: [
            { x: left, y },
            { x: left + width, y },
            { x: left + width, y: y + 8 * scale },
            { x: left, y: y + 8 * scale },
        ] },
    };
}

function ocrCell(text, left, y, right) {
    return {
        text: String(text),
        confidence: 0.99,
        boundingBox: { points: [
            { x: left, y },
            { x: right, y },
            { x: right, y: y + 8 },
            { x: left, y: y + 8 },
        ] },
    };
}

function makeVisualPage(pageNumber, headers, dataRows, anchors) {
    const rows = [headers, ...dataRows].map((values, rowIndex) => values.map((value, columnIndex) =>
        layoutCell(value, anchors[columnIndex], 100 + rowIndex * 14, rowIndex % 2 ? 1 : 1.2)
    ));
    return { page: pageNumber, width: Math.max(...anchors) + 200, height: 900, rows };
}

function makeTextPdf(lines) {
    const escaped = (value) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const commands = lines.map((line, index) => `BT /F1 10 Tf 40 ${780 - index * 16} Td (${escaped(line)}) Tj ET`).join('\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf, 'latin1'));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xrefStart = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let index = 1; index <= objects.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
}

async function testSelectiveNativePdfOcr() {
    const { PDFParse } = require('pdf-parse');
    const axios = require('axios');
    const originalGetText = PDFParse.prototype.getText;
    const originalGetScreenshot = PDFParse.prototype.getScreenshot;
    const originalDestroy = PDFParse.prototype.destroy;
    const originalPost = axios.post;
    const originalKey = process.env.AI_API_KEY;
    let screenshotOptions;
    let pageImagesSent = 0;
    process.env.AI_API_KEY = 'visual-test-key';
    PDFParse.prototype.getText = async () => ({ total: 3, pages: [] });
    PDFParse.prototype.getScreenshot = async function (options) {
        screenshotOptions = options;
        return {
            pages: (options.partial || []).map((pageNumber) => ({
                pageNumber,
                width: 900,
                height: 1200,
                data: Buffer.from(`rendered-page-${pageNumber}`),
            })),
        };
    };
    PDFParse.prototype.destroy = async () => {};
    axios.post = async (_url, request) => {
        pageImagesSent++;
        assert.match(request.input[0].url, /^data:image\/png;base64,/);
        const det = (text, left, top, right) => ({
            text_prediction: { text, confidence: 0.98 },
            bounding_box: { points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: top + 8 }, { x: left, y: top + 8 }] },
        });
        return { status: 200, data: { data: [{ text_detections: [
            det('Qty', 730, 100, 780),
            det('Description', 100, 100, 230),
            det('Unit', 600, 100, 630),
            det('Item No', 20, 100, 70),
            det('22699.40', 730, 120, 790),
            det('m', 600, 120, 620),
            det('Pump 200 mm', 100, 120, 260),
            det('72', 20, 120, 35),
        ] }] } };
    };
    try {
        const result = await pdfOcr.ocrNativePdfPages(Buffer.from('%PDF-1.7 test'), 'test-user', [2]);
        assert.deepEqual(screenshotOptions.partial, [2]);
        assert.equal(pageImagesSent, 1);
        assert.equal(result.pages[0].page, 2);
        assert.equal(result.pages[0].rows.length, 2);
        assert.deepEqual(result.pages[0].rows[1].map((cell) => cell.text), ['72', 'Pump 200 mm', 'm', '22699.40']);
        assert.equal(result.pages[0].rows[1][0].confidence, 0.98);
    } finally {
        PDFParse.prototype.getText = originalGetText;
        PDFParse.prototype.getScreenshot = originalGetScreenshot;
        PDFParse.prototype.destroy = originalDestroy;
        axios.post = originalPost;
        if (originalKey === undefined) delete process.env.AI_API_KEY;
        else process.env.AI_API_KEY = originalKey;
    }
}

function testScannedBoqVisualSourceRows() {
    const headers = ['S.No', 'Description', 'Quantity', 'Unit', 'Rate', 'Amount'];
    const makeHeader = (y) => [
        ocrCell('S.No', 20, y, 55),
        ocrCell('Description', 100, y, 225),
        ocrCell('Quantity', 600, y, 665),
        ocrCell('Unit', 700, y, 730),
        ocrCell('Rate', 780, y, 820),
        ocrCell('Amount', 870, y, 930),
    ];
    const makeRow = (serial, description, quantity, unit, rate, amount, y) => [
        ...(serial ? [ocrCell(serial, 20, y, 55)] : []),
        ...(description ? [ocrCell(description, 100, y, 540)] : []),
        ...(quantity ? [ocrCell(quantity, 600, y, 665)] : []),
        ...(unit ? [ocrCell(unit, 700, y, 730)] : []),
        ...(rate ? [ocrCell(rate, 780, y, 820)] : []),
        ...(amount ? [ocrCell(amount, 870, y, 930)] : []),
    ];
    const firstPageDetections = [
        ...makeHeader(100),
        ...makeRow('97', 'Prime Coat including preparation of surface', '', '', '', '', 130),
        ...makeRow('', 'and spraying a uniform coat', '53847.5', 'm²', '4807.66', '259000000.00', 141),
        ...makeRow('98', 'HDPE pipe 200mm PE80 PN6', '125', 'm', '121.25', '15156.25', 170),
        ...makeRow('99', 'HDPE pipe 600mm SN8 DWC', '48', 'm³', '300.00', '14400.00', 190),
        ...makeRow('100', 'HDPE pipe 250mm SN8 DWC', '300', 'No.', '4807.66', '100.00', 210),
        ...makeRow('101', 'HDPE pipe 300mm SN8 DWC', '75', 'Each', '437.32', '32799.00', 230),
        ...makeRow('102', 'HDPE pipe 110mm PE80 PN6', '', '', '', '', 250),
    ];
    const secondPageDetections = [
        ...makeHeader(100),
        ...makeRow('', '', '42', 'Km', '300.00', '12600.00', 130),
        ...makeRow('103', 'HDPE coupler DN80', '16', 'Set', '121.25', '1940.00', 160),
        ...makeRow('104', 'Valve chamber excavation', '9', 'Cum', '437.32', '3935.88', 180),
    ];
    const layoutPages = [firstPageDetections, secondPageDetections].map((detections, index) => ({
        page: index + 1,
        width: 1000,
        height: 800,
        rows: groupOcrDetections(detections),
    }));
    const tables = documentModel.reconstructTablesFromLayoutPages(layoutPages);
    assert.equal(tables.length, 1, 'repeated page header continues one visual table');
    const [table] = tables;
    assert.deepEqual(table.headers, headers, 'all source columns, including rate and amount, survive reconstruction');
    assert.equal(table.rows.length, 8, 'visual lines collapse into eight logical source rows');

    const rowsBySerial = new Map(table.rows.map((row) => [row.cells[0], row]));
    assert.equal(rowsBySerial.get('97').cells[1], 'Prime Coat including preparation of surface and spraying a uniform coat');
    assert.equal(rowsBySerial.get('97').cells[2], '53847.5');
    assert.equal(rowsBySerial.get('97').cells[3], 'm²');
    assert.equal(rowsBySerial.get('97').cells[4], '4807.66');
    assert.equal(rowsBySerial.get('97').cells[5], '259000000.00');
    for (const [serial, description, quantity, unit] of [
        ['98', '200mm PE80 PN6', '125', 'm'],
        ['99', '600mm SN8 DWC', '48', 'm³'],
        ['100', '250mm SN8 DWC', '300', 'No.'],
        ['101', '300mm SN8 DWC', '75', 'Each'],
    ]) {
        const row = rowsBySerial.get(serial);
        assert.ok(row.cells[1].includes(description), `${description} is on its own canonical row`);
        assert.equal(row.cells[2], quantity);
        assert.equal(row.cells[3], unit);
    }
    const continued = table.rows.find((row) => row.cells[1].includes('110mm PE80 PN6'));
    assert.ok(continued, 'description row continues across the page header');
    assert.equal(continued.cells[2], '42');
    assert.equal(continued.cells[3], 'Km');
    assert.deepEqual(continued.source.continuationSources.map((source) => source.page), [2]);

    const sourceItems = table.rows.map((row) => documentModel.lineItemFromRow({
        headers: table.headers,
        row: row.cells,
        source: row.source,
        headerMap: { columns: table.columnMap, ambiguous: table.ambiguousHeaders },
    }));
    assert.ok(sourceItems.every((item) => item.product === null), 'unit values are not misclassified as products before AI');
    assert.ok(sourceItems.every((item) => !['121.25', '300.00', '4807.66', '437.32'].includes(item.unit)), 'numeric rates never occupy the unit source column');
    assert.equal(sourceItems.find((item) => item.serialNumber === '97').unit, 'm²');

    const debugRows = documentModel.debugSourceRows(table);
    assert.match(debugRows[0], /SOURCE ROW 97/);
    assert.match(debugRows[0], /Description: Prime Coat including preparation of surface and spraying a uniform coat/);
    assert.match(debugRows[0], /Quantity: 53847\.5/);
    assert.match(debugRows[0], /Unit: m²/);
    assert.match(debugRows[0], /Rate: 4807\.66/);
    assert.match(debugRows[0], /Bounding boxes:/);
    assert.match(debugRows[0], /Raw OCR detections:/);

    const noSerialTable = documentModel.reconstructTablesFromLayoutPages([{
        page: 4,
        rows: groupOcrDetections([
            ocrCell('Description', 100, 100, 225),
            ocrCell('Quantity', 600, 100, 665),
            ocrCell('Unit', 700, 100, 730),
            ocrCell('Rate', 780, 100, 820),
            ocrCell('Amount', 870, 100, 930),
            ocrCell('Wrapped product description', 100, 130, 400),
            ocrCell('continued description', 100, 141, 360),
            ocrCell('10', 600, 141, 620),
            ocrCell('m', 700, 141, 720),
            ocrCell('121.25', 780, 141, 820),
            ocrCell('1212.50', 870, 141, 920),
            ocrCell('Second complete source item', 100, 180, 430),
            ocrCell('2', 600, 180, 620),
            ocrCell('Each', 700, 180, 735),
            ocrCell('300.00', 780, 180, 820),
            ocrCell('600.00', 870, 180, 920),
        ]),
    }])[0];
    assert.equal(noSerialTable.rows.length, 2, 'baseline proximity groups wrapped text without merging a following row');
    assert.equal(noSerialTable.rows[0].cells[0], 'Wrapped product description continued description');
    assert.equal(noSerialTable.rows[0].cells[1], '10');
    assert.equal(noSerialTable.rows[0].cells[3], '121.25');
    assert.equal(noSerialTable.rows[1].cells[0], 'Second complete source item');
    assert.equal(noSerialTable.rows[1].cells[2], 'Each');

    const unpositioned = documentModel.reconstructTablesFromLayoutPages([{
        page: 3,
        rows: [
            makeHeader(100),
            [{ text: 'unpositioned OCR evidence', confidence: 0.41 }],
        ],
    }])[0];
    assert.equal(unpositioned.rows.length, 1, 'unpositioned source evidence is retained rather than dropped');
    const unpositionedItem = documentModel.lineItemFromRow({
        headers: unpositioned.headers,
        row: unpositioned.rows[0].cells,
        source: unpositioned.rows[0].source,
        headerMap: { columns: unpositioned.columnMap, ambiguous: unpositioned.ambiguousHeaders },
    });
    assert.ok(unpositionedItem.warnings.some((warning) => /no usable bounding box/i.test(warning)));
    assert.equal(unpositionedItem.provenance.rawOcrDetections[0].text, 'unpositioned OCR evidence');
}

async function main() {
    await testSelectiveNativePdfOcr();
    testScannedBoqVisualSourceRows();
    const standard = await boqExtractor.parseDocument(
        await makeXlsx(['S.No', 'Description', 'Unit', 'Qty'], [['1', 'Valve DN50', 'nos', '2']]),
        '.xlsx', 'standard.xlsx'
    );
    assert.equal(standard.tables[0].rows[0].cells[3], '2');
    assert.equal(standard.tables[0].rows[0].source.sheet, 'Tender');

    const alternate = await boqExtractor.parseDocument(
        await makeXlsx(['Item Code', 'Item Name', 'U.O.M.', 'Estimate Quantity', 'Rate', 'Amount'], [['V-1', 'Valve DN50', 'nos', '22,699.40', '5', '10']]),
        '.xlsx', 'alternate.xlsx'
    );
    const alternateTable = alternate.tables[0];
    const item = documentModel.lineItemFromRow({
        headers: alternateTable.headers,
        row: alternateTable.rows[0].cells,
        source: alternateTable.rows[0].source,
        filename: alternate.metadata.filename,
        headerMap: { columns: alternateTable.columnMap, ambiguous: alternateTable.ambiguousHeaders },
    });
    const protectedItem = documentModel.mergeDerivedFields(item, {
        product: 'Valve', size: 'DN50', quantity: 1, unit: 'dia', specification: 'Class 150',
    });
    assert.equal(protectedItem.quantity, 22699.4);
    assert.equal(protectedItem.unit, 'nos');
    assert.equal(protectedItem.sourceValues['Estimate Quantity'], '22,699.40');
    assert.equal(protectedItem.sourceValues['Rate'], '5');
    assert.equal(protectedItem.provenance.columns.quantity, 'Estimate Quantity');
    assert.equal(protectedItem.provenance.row, 2);

    const csv = await boqExtractor.parseDocument(Buffer.from(
        'S.No,Description,Required Qty,Unit,Remarks\r\n1,"Pump, vertical\nwith ""motor""",4,set,Outdoor\r\n'
    ), '.csv', 'project.csv');
    assert.equal(csv.tables[0].rows[0].cells[1], 'Pump, vertical\nwith "motor"');
    assert.equal(csv.tables[0].columnMap.quantity.header, 'Required Qty');

    const docxTables = boqExtractor.parseDocxTables(
        '<table><tr><th>Sl.No</th><th>Particulars</th><th>UOM</th><th>Tender Quantity</th></tr><tr><td>8</td><td>Electrical panel</td><td>nos</td><td>2</td></tr></table>'
    );
    assert.equal(docxTables[0].rows[0].cells[1], 'Electrical panel');
    assert.equal(docxTables[0].columnMap.serialNumber.header, 'Sl.No');
    assert.equal(docxTables[0].columnMap.quantity.header, 'Tender Quantity');

    const nativePdf = await boqExtractor.parseDocument(makeTextPdf([
        'S.No | Description | Unit | Qty',
        '1 | Fire pump | set | 1',
    ]), '.pdf', 'native-table.pdf');
    assert.equal(nativePdf.pages.length, 1);
    assert.equal(nativePdf.tables[0].rows[0].cells[1], 'Fire pump');
    assert.equal(nativePdf.tables[0].rows[0].source.page, 1);

    const continued = documentModel.extractTablesAcrossPages([
        { page: 1, matrix: [['S.No', 'Description', 'Unit', 'Qty'], ['1', 'Concrete pump', 'set', '2']] },
        { page: 2, matrix: [['S.No', 'Description', 'Unit', 'Qty'], ['', 'with trailer', '', ''], ['2', 'Lighting tower', 'nos', '3']] },
        { page: 3, matrix: [['S.No', 'Description', 'Unit', 'Qty'], ['3', 'Cable', 'm', '80']] },
    ]);
    assert.equal(continued.length, 1);
    assert.equal(continued[0].rows.length, 3);
    assert.equal(continued[0].rows[0].cells[1], 'Concrete pump with trailer');
    assert.equal(continued[0].rows[0].source.continuationSources[0].page, 2);
    assert.equal(continued[0].rows[1].cells[1], 'Lighting tower');
    assert.equal(continued[0].rows[2].source.page, 3);

    const ambiguous = documentModel.mapHeaders(['Description', 'Qty', 'Quantity', 'Unit', 'Unit Rate']);
    assert.equal(ambiguous.columns.quantity, undefined);
    assert.equal(ambiguous.ambiguous.quantity.length, 2);
    assert.equal(ambiguous.columns.rate.header, 'Unit Rate');
    const missing = documentModel.lineItemFromRow({
        headers: ['Description', 'Quantity', 'Unit'],
        row: ['Control cabinet', '', ''],
    });
    assert.equal(missing.quantity, null);
    assert.equal(missing.unit, null);
    assert.ok(missing.warnings.some((warning) => /quantity could not be determined/i.test(warning)));
    assert.ok(missing.warnings.some((warning) => /unit could not be determined/i.test(warning)));

    const sameSpec = [
        { product: 'Valve', size: 'DN50', specification: 'Class 150', quantity: 2, unit: 'nos' },
        { product: 'Valve', size: 'DN100', specification: 'Class 150', quantity: 3, unit: 'nos' },
    ];
    assert.ok(documentModel.mergeDerivedFields({ ...sameSpec[0] }, {}).warnings.length === 0);
    assert.ok(!boqExtractor.flagAll(sameSpec).flat().some((warning) => /Duplicate line item/.test(warning)));

    const ocrRows = groupOcrDetections([
        { text: 'Qty', boundingBox: { points: [{ x: 80, y: 10 }, { x: 95, y: 10 }, { x: 95, y: 20 }, { x: 80, y: 20 }] } },
        { text: 'Item', boundingBox: { points: [{ x: 10, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 20 }, { x: 10, y: 20 }] } },
        { text: '2', boundingBox: { points: [{ x: 80, y: 30 }, { x: 85, y: 30 }, { x: 85, y: 40 }, { x: 80, y: 40 }] } },
        { text: 'Valve', boundingBox: { points: [{ x: 10, y: 30 }, { x: 28, y: 30 }, { x: 28, y: 40 }, { x: 10, y: 40 }] } },
    ]);
    assert.equal(ocrRows.length, 2);
    assert.deepEqual(ocrRows[1].map((cell) => cell.text), ['Valve', '2']);

    const visualFixtures = [
        { page: 1, headers: ['S.No', 'Item Description', 'Unit', 'Estimate Quantity'], rows: [['72', '200 mm dia coil HDPE pipe', 'm', '22699.40'], ['73', '110 mm dia pipe', 'm', '45398.80']], anchors: [20, 130, 540, 690] },
        { page: 2, headers: ['Sl No', 'Particulars', 'UOM', 'Qty'], rows: [['4', 'Distribution panel', 'nos', '2']], anchors: [50, 260, 780, 940] },
        { page: 3, headers: ['Item', 'Description', 'Measure', 'Required Qty'], rows: [['A1', 'Reinforced concrete footing', 'm3', '18']], anchors: [15, 100, 620, 755] },
        { page: 4, headers: ['Sr.No', 'Material Description', 'Unit of Measurement', 'Tender Quantity'], rows: [['9', 'Rotary drive assembly', 'set', '4']], anchors: [80, 180, 820, 1030] },
        { page: 5, headers: ['Item Code', 'Item Name', 'Unit', 'Quantity'], rows: [['EL-8', 'Control cable', 'm', '120']], anchors: [35, 210, 690, 810] },
    ];
    for (const fixture of visualFixtures) {
        const tables = documentModel.reconstructTablesFromLayoutPages([
            makeVisualPage(fixture.page, fixture.headers, fixture.rows, fixture.anchors),
        ]);
        assert.equal(tables.length, 1, `one generic visual table recognized on page ${fixture.page}`);
        assert.deepEqual(tables[0].headers, fixture.headers);
        assert.equal(tables[0].rows.length, fixture.rows.length);
        assert.deepEqual(tables[0].rows[0].cells, fixture.rows[0]);
    }

    const adversarialPage = {
        page: 7,
        width: 1000,
        height: 1200,
        rows: [
            [layoutCell('Sl No', 10, 100), layoutCell('Particulars', 100, 100), layoutCell('UOM', 650, 100), layoutCell('Qty', 820, 100)],
            [layoutCell('72', 10, 120), layoutCell('Providing and installing 200 mm dia coil', 100, 120), layoutCell('m', 650, 120), layoutCell('22699.40', 820, 120)],
            [layoutCell('including testing and delivery', 100, 140), layoutCell('', 650, 140), layoutCell('', 820, 140)],
            [layoutCell('73', 10, 160), layoutCell('110 mm dia pipe', 100, 160), layoutCell('m', 650, 160), layoutCell('45398.80', 820, 160)],
        ],
    };
    const adversarialTable = documentModel.reconstructTablesFromLayoutPages([adversarialPage])[0];
    assert.equal(adversarialTable.rows.length, 2);
    assert.match(adversarialTable.rows[0].cells[1], /200 mm dia coil including testing and delivery/);
    assert.equal(adversarialTable.rows[0].cells[2], 'm');
    assert.equal(adversarialTable.rows[0].cells[3], '22699.40');
    assert.equal(adversarialTable.rows[1].cells[1], '110 mm dia pipe');
    assert.equal(adversarialTable.rows[1].cells[2], 'm');
    assert.equal(adversarialTable.rows[1].cells[3], '45398.80');
    const visualSourceItem = documentModel.lineItemFromRow({
        headers: adversarialTable.headers,
        row: adversarialTable.rows[0].cells,
        source: adversarialTable.rows[0].source,
        headerMap: { columns: adversarialTable.columnMap, ambiguous: adversarialTable.ambiguousHeaders },
    });
    const visualProtectedItem = documentModel.mergeDerivedFields(visualSourceItem, {
        product: 'Pipe', size: '200 mm', quantity: 1, unit: 'coil',
    });
    assert.equal(visualProtectedItem.quantity, 22699.4);
    assert.equal(visualProtectedItem.unit, 'm');
    assert.equal(visualProtectedItem.sourceValues.Qty, '22699.40');
    assert.equal(visualProtectedItem.sourceValues.UOM, 'm');
    assert.deepEqual(documentModel.findVisualTablePages([
        { page: 1, text: 'Title page' },
        { page: 2, text: 'Sl No Particulars UOM Qty' },
        { page: 3, text: '72\tSome work\tm\t22699.40' },
        { page: 4, text: 'Endnotes' },
    ]), [2, 3]);

    const batchEntries = Array.from({ length: 10 }, (_, index) => ({
        item: {
            lineItemId: `row-${index + 1}`,
            description: `Item ${index + 1}`,
            product: `Product ${index + 1}`,
            quantity: 1,
            unit: 'm',
            provenance: { page: 1, table: 1, row: index + 1 },
        },
        row: { cells: [`${index + 1}`, `Item ${index + 1}`, 'm', '1'] },
    }));
    const batches = boqExtractor.splitStructuredRowBatches(batchEntries, 4, 5000);
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 4);
    assert.equal(batches[2].length, 2);
    const validated = boqExtractor.validateStructuredBatchResponse({
        items: [
            { rowId: 'row-1', product: 'Pipe', size: '200 mm', specification: null, application: null, remarks: null, confidence: {}, warnings: [] },
            { rowId: 'row-2', product: 'Pipe', size: '110 mm', specification: null, application: null, remarks: null, confidence: {}, warnings: [] },
        ],
    }, ['row-1', 'row-2']);
    assert.equal(validated.length, 2);
    assert.equal(boqExtractor.validateStructuredBatchResponse({ items: [{ rowId: 'row-1', product: 'Pipe' }] }, ['row-1']).length, 1,
        'object-shaped { items: [...] } responses validate');
    assert.throws(() => boqExtractor.validateStructuredBatchResponse('{"items":[', ['row-1']), /structured extraction data/i,
        'malformed JSON is rejected before merge');
    assert.throws(() => boqExtractor.validateStructuredBatchResponse({
        items: [{ rowId: 'row-1', quantity: 1, unit: 'm', product: 'Pipe', size: '200 mm', specification: null, application: null, remarks: null, confidence: {}, warnings: [] }],
    }, ['row-1']), /quantity.*unit.*authoritative/i);
    assert.throws(() => boqExtractor.validateStructuredBatchResponse({
        items: [{ rowId: 'row-1', source: { page: 1 }, product: 'Pipe' }],
    }, ['row-1']), /forbidden field "source"/i);

    const protectedTable = {
        headers: ['S.No', 'Serial No', 'Item Code', 'Qty', 'Quantity', 'Unit', 'Description'],
    };
    const protectedEntry = {
        item: {
            lineItemId: 'protected.xlsx:Tender:1:1:2',
            description: 'Visible valve description',
            provenance: { page: 1, sheet: 'Tender', table: 1, row: 2, continuationSources: [] },
        },
        row: { cells: ['SERIAL-PRIVATE-A', 'SERIAL-PRIVATE-B', 'CODE-PRIVATE', 'QTY-PRIVATE-A', 'QTY-PRIVATE-B', 'UNIT-PRIVATE', 'Visible valve description'] },
    };
    const protectedPrompt = boqExtractor.buildStructuredExtractionPrompt(protectedTable, [protectedEntry]);
    for (const privateSourceValue of ['SERIAL-PRIVATE-A', 'SERIAL-PRIVATE-B', 'CODE-PRIVATE', 'QTY-PRIVATE-A', 'QTY-PRIVATE-B', 'UNIT-PRIVATE']) {
        assert.ok(!protectedPrompt.includes(privateSourceValue), `${privateSourceValue} is excluded from the AI prompt`);
    }
    assert.ok(protectedPrompt.includes('Visible valve description'), 'descriptive content remains available for interpretation');

    for (const rowCount of [10, 100, 500]) {
        const largeEntries = Array.from({ length: rowCount }, (_, index) => ({
            item: {
                lineItemId: `source-${index + 1}`,
                description: 'Repeated wrapped procurement description',
                product: 'Pump assembly',
                size: 'DN100',
                specification: 'Class 150',
                quantity: 5,
                unit: 'nos',
                provenance: { page: Math.floor(index / 25) + 1, table: 1, row: index + 2 },
            },
            row: { cells: [`${index + 1}`, 'Repeated wrapped procurement description', 'DN100', 'Class 150', '5', 'nos'] },
        }));
        const largeBatches = boqExtractor.splitStructuredRowBatches(largeEntries);
        const flattened = largeBatches.flat();
        assert.equal(flattened.length, rowCount, `${rowCount} source rows survive splitting`);
        assert.deepEqual(flattened.map(({ item: sourceItem }) => sourceItem.lineItemId), largeEntries.map(({ item: sourceItem }) => sourceItem.lineItemId),
            `${rowCount} rows merge in stable source order without deduplication`);
        assert.ok(largeBatches.every((batch) => batch.length <= 40), `${rowCount} rows respect the row limit`);
        assert.ok(largeBatches.every((batch) => batch.length === 1 || boqExtractor.estimateBatchChars(batch) <= 12000),
            `${rowCount} rows respect the complete prompt character limit`);
        assert.ok(largeBatches.length >= Math.ceil(rowCount / 40), `${rowCount} rows create at least the row-bound batch count`);
        if (rowCount === 500) {
            assert.equal(new Set(largeEntries.map(({ item: sourceItem }) => sourceItem.lineItemId)).size, 500,
                'duplicate-looking descriptions and quantities retain distinct source row IDs');
        }
    }

    const continuedEntries = continued[0].rows.map((row) => ({
        row,
        item: documentModel.lineItemFromRow({ headers: continued[0].headers, row: row.cells, source: row.source }),
    }));
    const continuationBatches = boqExtractor.splitStructuredRowBatches(continuedEntries, 1, 6000);
    assert.equal(continuationBatches.length, 3);
    assert.match(continuationBatches[0][0].item.description, /Concrete pump with trailer/,
        'a multi-page wrapped row remains one complete source row even when it occupies a batch boundary');
    assert.equal(continuationBatches[0][0].item.provenance.continuationSources[0].page, 2);

    console.log('✅ Structured BOQ model tests passed (XLSX variants, CSV, DOCX tables, native PDF, visual layouts, source authority, continuation, missing fields, non-pipe items).');
}

main().catch((error) => {
    console.error('❌ Structured BOQ model test failed:', error);
    process.exitCode = 1;
});
