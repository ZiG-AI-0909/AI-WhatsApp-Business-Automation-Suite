'use strict';

const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const domain = require('../quotationDomain');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

async function run() {
    const headers = ['SKU', 'Product Name', 'Category', 'Size', 'PN', 'Standard', 'UOM', 'Unit Price', 'HSN', 'GST'];
    const map = domain.mapPriceListHeaders(headers);
    assert.deepEqual(
        ['item_code', 'name', 'category', 'size', 'pressure_class', 'specification', 'unit', 'rate', 'hsn_code', 'gst_percent'].map((field) => map[field]),
        headers.map((_header, index) => index),
        'Excel header aliases map all required catalogue columns',
    );
    const imported = domain.validatePriceListRow(['P-1', 'Pipe', 'Pipes', '50 mm', 'PN10', 'IS 1239', 'm', '125.50', '7306', 18], map, 2);
    assert.equal(imported.valid, true);
    assert.equal(imported.item.rate, 125.5);

    const catalogue = [
        { id: 1, item_code: 'A-1', name: 'PVC Pipe', size: '50 mm', pressure_class: 'PN 10', unit: 'm', rate: 120, active: true },
        { id: 2, item_code: 'A-2', name: 'PVC Pipe', size: '65 mm', pressure_class: 'PN 10', unit: 'm', rate: 140, active: true },
    ];
    const codeMatch = domain.matchPriceListItem({ itemCode: 'A-1', product: 'Different description' }, catalogue);
    assert.equal(codeMatch.status, 'matched');
    assert.equal(codeMatch.reason, 'exact item code');
    const specMatch = domain.matchPriceListItem({ product: 'PVC Pipe', size: '50 mm', pressureClass: 'PN10', unit: 'm' }, catalogue);
    assert.equal(specMatch.status, 'matched');
    assert.equal(specMatch.priceListItem.id, 1);
    const noMatch = domain.matchPriceListItem({ product: 'Copper elbow', size: '2 inch', unit: 'each' }, []);
    assert.equal(noMatch.status, 'unmatched');
    assert.equal(noMatch.priceListItem, null);
    assert.deepEqual(noMatch.candidates, []);

    const totals = domain.calculateQuotation([{
        quantity: 3, rate: 123.456, discount_percent: 10, gst_percent: 18,
    }], {
        discount_percent: 5, freight: 10, customer_state: 'Karnataka',
    }, 'Karnataka');
    assert.equal(totals.subtotal, 333.33);
    assert.equal(totals.discount_amount, 16.67);
    assert.equal(totals.tax_total, 57);
    assert.equal(totals.cgst, 28.5);
    assert.equal(totals.sgst, 28.5);
    assert.equal(totals.igst, 0);
    assert.equal(totals.grand_total, 383.66);
    const interStateTotals = domain.calculateQuotation([{ quantity: 1, rate: 100, gst_percent: 18 }], { customer_state: 'Tamil Nadu' }, 'Karnataka');
    assert.equal(interStateTotals.igst, 18);
    assert.equal(interStateTotals.cgst, 0);
    assert.equal(domain.fiscalYearFor(new Date('2026-05-01T00:00:00Z')), '2026-27');
    assert.equal(domain.fiscalYearFor(new Date('2026-03-31T00:00:00Z')), '2025-26');
    assert.equal(domain.formatQuoteNumber(8, new Date('2026-05-01T00:00:00Z')), 'SP/2026-27/0008');

    const fakeRows = {
        quotations: [{ id: 41, user_id: USER_B, quote_number: 'SP/2026-27/0001' }],
    };
    const clientPath = require.resolve('../../database/supabaseClient');
    require.cache[clientPath] = {
        id: clientPath,
        filename: clientPath,
        loaded: true,
        exports: {
            supabase: {
                from(table) {
                    const filters = [];
                    const builder = {
                        select() { return builder; },
                        eq(column, value) { filters.push([column, value]); return builder; },
                        maybeSingle: async () => ({
                            data: (fakeRows[table] || []).find((row) => filters.every(([column, value]) => String(row[column]) === String(value))) || null,
                            error: null,
                        }),
                    };
                    return builder;
                },
            },
            isAvailable: () => true,
            transaction: async () => {},
            parseJsonFields: (row) => row,
        },
    };
    const service = require('../quotationService');
    assert.equal(await service.selectOwned('quotations', 41, USER_A), null, 'another tenant cannot fetch the quotation');
    assert.equal((await service.selectOwned('quotations', 41, USER_B)).quote_number, 'SP/2026-27/0001');
    assert.equal(service.quoteItemFromBoq({ product: 'Unpriced part', quantity: 1 }, 1, noMatch).rate, null, 'an unmatched BOQ item never receives an invented rate');
    assert.equal(service.amountInWordsIndian(383.66), 'Three Hundred Eighty Three rupees and Sixty Six paise only');

    const priceListRoute = require('../../routes/priceList');
    const importWorkbook = new ExcelJS.Workbook();
    const importSheet = importWorkbook.addWorksheet('Price List');
    importSheet.addRow(['SKU', 'Product Name', 'Category', 'Size', 'PN', 'Standard', 'UOM', 'Unit Price', 'HSN', 'GST']);
    importSheet.addRow(['P-1', 'Pipe', 'Pipes', '50 mm', 'PN10', 'IS 1239', 'm', 125.5, '7306', 18]);
    importSheet.addRow(['P-1', 'Duplicate Pipe', 'Pipes', '50 mm', 'PN10', 'IS 1239', 'm', 125.5, '7306', 18]);
    const parsedUpload = await priceListRoute.readRows({
        originalname: 'price-list.xlsx',
        buffer: Buffer.from(await importWorkbook.xlsx.writeBuffer()),
    });
    assert.equal(parsedUpload[0].valid, true);
    assert.equal(parsedUpload[1].valid, false);
    assert.ok(parsedUpload[1].errors.some((error) => error.includes('duplicate item code')));
    const parsedCsv = await priceListRoute.readRows({
        originalname: 'price-list.csv',
        buffer: Buffer.from('item code,description,size,PN,unit,rate,HSN,GST\nC-1,Valve,25 mm,PN 16,each,88.5,8481,18\n'),
    });
    assert.equal(parsedCsv.length, 1);
    assert.equal(parsedCsv[0].valid, true);
    assert.equal(parsedCsv[0].item.pressure_class, 'PN 16');

    const itemLines = Array.from({ length: 300 }, (_value, index) => ({
        line_no: index + 1,
        description: `Industrial pipe line item ${index + 1}`,
        size: '50 mm',
        hsn_code: '7306',
        quantity: 2,
        unit: 'm',
        rate: 100 + index,
        discount_percent: 0,
        gst_percent: 18,
        amount: 0,
        match_status: 'manual',
    }));
    const quotation = {
        quote_number: 'SP/2026-27/0001',
        created_at: '2026-05-01T00:00:00.000Z',
        validity_days: 30,
        project_name: '300 line test',
        discount_percent: 5,
        freight: 25,
        customer_state: 'Karnataka',
    };
    const company = { name: 'Test Company', state: 'Karnataka', address: 'Test address' };
    const pdf = await service.renderPdf(quotation, itemLines, company);
    assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.3');
    assert.ok(pdf.length > 10000, '300-line PDF is generated with multiple pages');
    const excelBuffer = await service.renderExcel({ ...quotation, items: itemLines }, itemLines, company);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(excelBuffer));
    const sheet = workbook.getWorksheet('Quotation');
    assert.equal(sheet.rowCount, 314);
    assert.equal(sheet.getCell('J8').type, ExcelJS.ValueType.Formula, 'per-line amount is an Excel formula');
    assert.equal(sheet.getCell('J309').type, ExcelJS.ValueType.Formula, 'subtotal is an Excel formula');

    const { createQuotationMigrationGuard, PENDING_MESSAGE } = require('../../database/quotationMigrationGuard');
    const logged = [];
    const guard = createQuotationMigrationGuard({
        client: {
            from(table) {
                return {
                    select() { return this; },
                    limit: async () => ({ error: table === 'quotation_items' ? { code: '42P01' } : null }),
                };
            },
            rpc: async () => ({ data: true, error: null }),
        },
        databaseAvailable: () => true,
        logger: { error: (message) => logged.push(message), info: () => {} },
        now: () => 0,
    });
    assert.equal((await guard.check()).ok, false);
    assert.deepEqual(logged, [PENDING_MESSAGE]);

    console.log('quotation-smoke.test.js passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
