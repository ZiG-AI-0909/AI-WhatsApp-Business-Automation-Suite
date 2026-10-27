// =============================================================
// Smoke test — Proforma Invoice Maker, end to end through the real routes.
//
// An in-memory Supabase stand-in (filters, unique invoice number per user,
// missing-table mode) is injected before the modules load.
//
// Covers: totals for the reference invoice (Ex-Works 94,121.00, FOB
// 97,421.00, Grand Total 116,621.00), amount in words, validation messages
// (never a silent zero), the Excel layout (merges, widths, borders, print
// setup) and live formulas with cached results, formula ranges after adding /
// removing / duplicating rows, optional charges counted once, payment text
// formulas, preview/export routes, save/list/load/delete with per-user
// isolation, the number clash, next-number suggestion, and graceful
// behaviour before the migration has run.
//
// Run: node backend/src/proforma/__tests__/proforma-smoke.test.js
// =============================================================
'use strict';

const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

// ── In-memory Supabase ────────────────────────────────────────
const tables = { proforma_invoices: [], proforma_profiles: [] };
let missingTables = false;
let nextId = 1;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function numberClash(row, ignoreId) {
    if (!row.invoice_number) return null;
    const clash = tables.proforma_invoices.find((other) => other.id !== ignoreId && other.user_id === row.user_id && other.invoice_number === row.invoice_number);
    return clash ? { code: '23505', message: 'duplicate key value violates unique constraint "idx_proforma_invoices_user_number"' } : null;
}

function orCondition(expression) {
    const conditions = expression.split(',').map((part) => {
        const [column, op, ...rest] = part.split('.');
        return { column, op, value: rest.join('.') };
    });
    return (row) => conditions.some(({ column, op, value }) => op === 'ilike'
        && String(row[column] ?? '').toLowerCase().includes(value.replace(/%/g, '').toLowerCase()));
}

function from(table) {
    const state = { op: 'select', filters: [], order: null, range: null, limit: null, payload: null, returning: false };
    const rows = () => tables[table];
    const match = (row) => state.filters.every((filter) => filter(row));
    async function run() {
        if (missingTables) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
        if (state.op === 'insert') {
            const row = { id: nextId++, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...clone(state.payload) };
            const clash = numberClash(row);
            if (clash) return { data: null, error: clash };
            rows().push(row);
            return { data: [clone(row)], error: null };
        }
        if (state.op === 'upsert') {
            const index = rows().findIndex((row) => row.user_id === state.payload.user_id);
            if (index >= 0) rows()[index] = { ...rows()[index], ...clone(state.payload) };
            else rows().push(clone(state.payload));
            return { data: null, error: null };
        }
        if (state.op === 'update') {
            const updated = [];
            for (const row of rows().filter(match)) {
                const clash = numberClash({ ...row, ...state.payload }, row.id);
                if (clash) return { data: null, error: clash };
                Object.assign(row, clone(state.payload), { updated_at: new Date(Date.now() + nextId++).toISOString() });
                updated.push(clone(row));
            }
            return { data: updated, error: null };
        }
        if (state.op === 'delete') {
            const removed = rows().filter(match).map(clone);
            tables[table] = rows().filter((row) => !match(row));
            return { data: removed, error: null };
        }
        let result = rows().filter(match).map(clone);
        if (state.order) {
            const [column, ascending] = state.order;
            result.sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
        }
        const count = result.length;
        if (state.range) result = result.slice(state.range[0], state.range[1] + 1);
        if (state.limit !== null) result = result.slice(0, state.limit);
        return { data: result, error: null, count };
    }
    const api = {
        select() { return api; },
        eq(column, value) { state.filters.push((row) => String(row[column]) === String(value)); return api; },
        or(expression) { state.filters.push(orCondition(expression)); return api; },
        order(column, { ascending = true } = {}) { state.order = [column, ascending]; return api; },
        range(start, end) { state.range = [start, end]; return api; },
        limit(count) { state.limit = count; return api; },
        insert(payload) { state.op = 'insert'; state.payload = payload; return api; },
        update(payload) { state.op = 'update'; state.payload = payload; return api; },
        upsert(payload) { state.op = 'upsert'; state.payload = payload; return api; },
        delete() { state.op = 'delete'; return api; },
        async maybeSingle() { const { data, error } = await run(); return { data: Array.isArray(data) ? data[0] ?? null : data, error }; },
        async single() {
            const { data, error } = await run();
            if (error) return { data: null, error };
            const row = Array.isArray(data) ? data[0] : data;
            return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        },
        then(resolve, reject) { return run().then(resolve, reject); },
    };
    return api;
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: { supabase: { from }, isAvailable: () => true, normalizeRow: (row) => row, parseJsonFields: (row) => row },
};

const defaults = require('../proformaDefaults');
const calc = require('../proformaCalculation');
const { sanitizeInvoice, sanitizeProfile, validateInvoice } = require('../proformaValidation');
const exporter = require('../proformaExport');
const router = require('../../routes/proforma');

// ── Route driver ──────────────────────────────────────────────
async function api(method, path, { user = USER_A, body = {}, query = {} } = {}) {
    const layer = router.stack.find((entry) => entry.route?.methods[method.toLowerCase()] && entry.match(path));
    assert.ok(layer, `route ${method} ${path} exists`);
    const req = { method, params: layer.params, body, query, user: { id: user }, headers: {} };
    const response = { statusCode: 200, headers: {}, body: undefined };
    const res = {
        status(code) { response.statusCode = code; return res; },
        json(payload) { response.body = payload; return res; },
        send(payload) { response.body = payload; return res; },
        type(value) { response.headers['content-type'] = value; return res; },
        setHeader(key, value) { response.headers[key.toLowerCase()] = value; },
    };
    for (const step of layer.route.stack) {
        let advanced = false;
        await step.handle(req, res, () => { advanced = true; });
        if (!advanced) break;
    }
    return response;
}

async function loadSheet(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return { workbook, sheet: workbook.getWorksheet('Proforma Invoice') };
}

const formulaOf = (cell) => cell.value?.formula || cell.value?.sharedFormula || null;
const resultOf = (cell) => cell.value?.result;

async function run() {
    // ── Calculation on the reference invoice ─────────────────
    const sample = sanitizeInvoice(defaults.sampleInvoice());
    const totals = calc.calculate(sample);
    assert.deepEqual(totals.items.map((item) => item.amount), [17200, 28785, 11225, 22470, 9500, 4941], 'reference line amounts');
    assert.equal(totals.total_qty, 5648, 'reference total quantity');
    assert.equal(totals.ex_works, 94121);
    assert.equal(totals.inland_freight, 3300);
    assert.equal(totals.fob, 97421);
    assert.equal(totals.ocean_freight, 19200);
    assert.equal(totals.grand_total, 116621);
    assert.equal(totals.balance, 106621, 'balance = grand total - advance');
    assert.equal(totals.amount_in_words, 'United States Dollars One Hundred Sixteen Thousand Six Hundred Twenty One and Zero Cents only.');
    assert.deepEqual(validateInvoice(sample), {}, 'the reference sample is valid');

    // Words: the reference's own wording for 34,278.00, cents, millions, currencies.
    assert.equal(calc.amountInWords(34278), 'United States Dollars Thirty Four Thousand Two Hundred Seventy Eight and Zero Cents only.');
    assert.equal(calc.amountInWords(1000000.05), 'United States Dollars One Million and Five Cents only.');
    assert.equal(calc.amountInWords(0.99), 'United States Dollars Zero and Ninety Nine Cents only.');
    assert.equal(calc.amountInWords(1.005), 'United States Dollars One and One Cents only.', 'decimal-correct rounding to cents');
    assert.equal(calc.amountInWords(250, 'AED'), 'UAE Dirhams Two Hundred Fifty and Zero Fils only.');
    assert.equal(calc.amountInWords(999999999.99), 'United States Dollars Nine Hundred Ninety Nine Million Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Cents only.');
    assert.throws(() => calc.amountInWords(1e9), /too large/);
    const wordsFormula = calc.wordsFormula('$L$35');
    assert.ok(wordsFormula.length < 8192, 'words formula fits the Excel formula length limit');
    assert.ok(!/TEXT\(|VALUE\(/.test(wordsFormula), 'words formula has no locale-dependent TEXT/VALUE');
    for (const literal of wordsFormula.match(/"(?:[^"]|"")*"/g)) assert.ok(literal.length <= 257, 'no string constant over 255 characters');
    const longLiteral = calc.excelString('"'.repeat(300));
    for (const literal of longLiteral.split('&')) assert.ok(literal.length <= 257, 'escaped chunks stay under 255 characters');

    // Other charges: counted once, and only when "include in total".
    const withCharges = sanitizeInvoice({
        ...defaults.sampleInvoice(),
        other_charges: [
            { id: 'ins', description: 'Insurance', unit: 'Lot', qty: 1, rate: 250.5, include_in_total: true },
            { id: 'hand', description: 'Handling (buyer pays locally)', unit: 'Lot', qty: 1, rate: 100, include_in_total: false },
            { id: 'disc', description: 'Discount', unit: 'Lot', qty: 1, rate: -50, include_in_total: true },
        ],
    });
    const chargeTotals = calc.calculate(withCharges);
    assert.equal(chargeTotals.other_included, 200.5);
    assert.equal(chargeTotals.grand_total, 116821.5);
    assert.deepEqual(validateInvoice(withCharges), {}, 'negative adjustment rates are allowed for other charges');

    // Freight switched off: FOB = Ex-Works, Grand Total = FOB.
    const noFreight = sanitizeInvoice({ ...defaults.sampleInvoice(), inland_freight: { include: false }, ocean_freight: { include: false } });
    assert.equal(calc.calculate(noFreight).grand_total, 94121);
    assert.deepEqual(validateInvoice(noFreight), {}, 'excluded freight needs no description or rate');

    // ── Validation: clear messages, never a silent zero ──────
    const blank = sanitizeInvoice(defaults.blankInvoice());
    const blankErrors = validateInvoice(blank);
    for (const path of ['invoice.number', 'consignee.name', 'consignee.address', 'shipping.incoterm_place', 'shipping.port_of_discharge', 'shipping.destination_country',
        `items.${blank.items[0].id}.specification`, `items.${blank.items[0].id}.qty`, `items.${blank.items[0].id}.rate`,
        'inland_freight.qty', 'inland_freight.rate', 'ocean_freight.description', 'ocean_freight.qty', 'payment.advance']) {
        assert.ok(blankErrors[path], `blank invoice reports ${path}`);
    }
    assert.equal(blankErrors['payment.advance'], 'Advance amount is required.', 'advance required because the payment text quotes it');
    const bad = sanitizeInvoice({
        ...defaults.sampleInvoice(),
        invoice: { ...defaults.sampleInvoice().invoice, date: '2026-02-30', currency: 'XYZ' },
        consignee: { ...defaults.sampleInvoice().consignee, email: 'not-an-email' },
        items: [{ id: 'a', size: '3"', qty: 'ten', rate: '-1', hsn: '39A' }, { id: 'b', specification: 'Heavy', qty: 0, rate: 5 }],
        payment: { advance: 999999999, summary: 'Pay {advance} {bogus}' },
    });
    const badErrors = validateInvoice(bad);
    assert.equal(badErrors['invoice.date'], 'Enter a valid invoice date.');
    assert.match(badErrors['invoice.currency'], /Currency must be one of/);
    assert.equal(badErrors['consignee.email'], 'Enter a valid email address.');
    assert.equal(badErrors['items.a.qty'], 'Quantity must be a number.');
    assert.equal(badErrors['items.a.rate'], 'Unit price must be greater than 0.');
    assert.equal(badErrors['items.a.hsn'], 'HSN code must be 4 to 10 digits.');
    assert.equal(badErrors['items.b.qty'], 'Quantity must be greater than 0.');
    assert.equal(badErrors['payment.advance'], 'The advance cannot be more than the grand total.');
    assert.equal(badErrors['payment.summary'], 'Unknown placeholder {bogus}.');
    assert.equal(calc.calculate(bad).items[0].amount, null, 'an invalid quantity gives no amount, not zero');

    // Sanitizing: duplicate / unsafe ids are replaced, buyer copy, text caps.
    const messy = sanitizeInvoice({ items: [{ id: 'x' }, { id: 'x' }, { id: '<script>' }], buyer: { same_as_consignee: true }, consignee: { name: 'PMtech', address: 'Line 1\r\nLine 2' }, invoice: { number: 'A\nB' } });
    assert.equal(new Set(messy.items.map((item) => item.id)).size, 3, 'ids are unique');
    assert.ok(messy.items.every((item) => /^[A-Za-z0-9_-]+$/.test(item.id)));
    assert.equal(messy.buyer.name, 'PMtech', 'same-as-consignee copies the consignee');
    assert.equal(messy.consignee.address, 'Line 1\nLine 2', 'multiline addresses keep their lines');
    assert.equal(messy.invoice.number, 'A B', 'single-line fields drop line breaks');

    // ── Excel: layout replicating the reference ──────────────
    const { buffer, layout } = await exporter.buildProformaWorkbook(sample);
    const { workbook, sheet } = await loadSheet(buffer);
    assert.equal(sheet.getCell('A1').value, 'PROFORMA INVOICE');
    assert.equal(sheet.getCell('A1').font.bold, true);
    assert.equal(sheet.getCell('A2').value, 'Manufacturer & Exporter:');
    assert.equal(sheet.getCell('A3').value, 'M/s. Sudarshan Extrusions Pvt. Ltd.');
    assert.equal(sheet.getCell('A4').value, '105, Phase IV, Bommasandra Industrial Area, Hosur Road');
    assert.equal(sheet.getCell('A5').value, 'Bangalore - 560099, Karnataka, India');
    assert.equal(sheet.getCell('A6').value, 'Contact: Mr. Aayush Salampuria - (M) +91 97423 50063');
    assert.equal(sheet.getCell('A7').value, 'GSTIN: 29AACCK1590L1Z6; IEC: 0705014487');
    assert.equal(sheet.getCell('H3').value, 'Alfatth_26-27/PI-03R5');
    assert.deepEqual(sheet.getCell('H4').value.richText.map((run) => run.text), ['Dated: 26', 'th', ' October 2026']);
    assert.equal(sheet.getCell('H4').value.richText[1].font.vertAlign, 'superscript', '"th" is superscript as in the reference');
    assert.equal(sheet.getCell('H6').value, 'Based on WhatsApp correspondence & subsequent telephonic discussions');
    assert.equal(sheet.getCell('H7').value, 'Emailid: Abdelhamed@alfatth-uae.com, Tel. +971 54 733 1749');
    assert.equal(sheet.getCell('A9').value, 'PMtech Water Solutions');
    assert.equal(sheet.getCell('A10').value, 'K28, Plot 39-Abu Rawash Industrial Zone, Giza, Egypt', 'country not repeated when the address ends with it');
    assert.equal(sheet.getCell('A11').value, 'Tax Registration Number: 757121691');
    assert.equal(sheet.getCell('A12').value, 'ACID No.: To be provided by Buyer prior to the shipment.');
    assert.equal(sheet.getCell('A13').value, 'Email ID: Abdelhamed@pmtech-egypt.com, Tel. +20 10 0439 6443');
    assert.equal(sheet.getCell('H9').value, 'ALFATTH Import and Export FZ-LLC');
    assert.equal(sheet.getCell('H10').value, 'A2-1505A, Building no. A2, Al Hamra Industrial Zone-FZ\nRas Al Khaimah, UAE, Tax Regn. No. 104817492200001');
    assert.equal(sheet.getCell('H13').value, 'INDIA');
    assert.equal(sheet.getCell('K13').value, 'EGYPT');
    assert.equal(sheet.getCell('A15').value, 'Road');
    assert.equal(sheet.getCell('D15').value, 'Bangalore / Chennai Port, India');
    assert.equal(sheet.getCell('H15').value, 'CFR Alexandria Port, Egypt');
    assert.equal(sheet.getCell('D18').value, 'Chennai Port, India');
    assert.equal(sheet.getCell('A20').value, 'Alexandria Port, Egypt');
    assert.equal(sheet.getCell('D20').value, 'Giza, Egypt');
    assert.equal(sheet.getCell('H19').font.underline, true);
    assert.equal(sheet.getCell('H20').value, 'State Bank of India, Electronic City Branch, Bangalore, India');
    assert.equal(sheet.getCell('H21').value, 'A/c No.: 37365498723 SWIFT Code: SBININBBA32 IFSC: SBIN0063971');

    const merges = sheet.model.merges;
    for (const range of ['A1:L1', 'A2:G2', 'H2:L2', 'H10:L11', 'H12:J12', 'K12:L12', 'A14:C14', 'D14:G14', 'A16:C17', 'D16:G17', 'H16:L18', 'A20:C21', 'D20:G21', 'B22:G22']) {
        assert.ok(merges.includes(range), `merged ${range}`);
    }
    assert.deepEqual(['A', 'B', 'H', 'I', 'J', 'K', 'L'].map((column) => sheet.getCell(`${column}22`).value),
        ['Sl. No.', 'Description of Goods', 'Length per Pipe (Mtr.)', 'HSN Code', 'Quantity (Pieces)', 'Unit Price (USD / Piece)', 'Amount (USD)']);
    const widthsPx = sheet.columns.slice(0, 12).map((column) => Math.round(column.width * 7 + 5));
    assert.deepEqual(widthsPx, exporter.COLUMN_PX, 'column widths match the reference (px)');
    assert.equal(sheet.getCell('A22').border.top.style, 'thin', 'table header is boxed');
    assert.equal(sheet.getCell('H2').border.left.style, 'thin', 'vertical divider between the two header halves');

    // Group heading + items.
    assert.equal(layout.firstItemRow, 23);
    assert.equal(sheet.getCell('B23').value, 'PVC Pipes - uPVC Column Pipes');
    assert.equal(sheet.getCell('B23').font.bold, true);
    assert.deepEqual(['A', 'B', 'C', 'F', 'G', 'H', 'I', 'J', 'K'].map((column) => sheet.getCell(`${column}24`).value),
        [1, '3"', 'Super Deluxe / Standard', '17 kgf/cm²', '(Standard Coupler)', 3, '39172390', 1720, 10]);
    assert.equal(sheet.getCell('H24').numFmt, '0.0" Mtr."', 'length shows as "3.0 Mtr." but stays numeric');
    for (let row = 24; row <= 29; row++) {
        assert.equal(formulaOf(sheet.getCell(`L${row}`)), `IF(OR(J${row}="",K${row}=""),"",ROUND(J${row}*K${row},2))`, `amount formula row ${row}`);
    }
    assert.equal(resultOf(sheet.getCell('L25')), 28785);
    assert.equal(formulaOf(sheet.getCell(`J${layout.exWorksRow}`)), 'SUM(J23:J29)');
    assert.equal(formulaOf(sheet.getCell(`L${layout.exWorksRow}`)), 'SUM(L23:L29)');
    assert.equal(resultOf(sheet.getCell(`L${layout.exWorksRow}`)), 94121);
    assert.equal(sheet.getCell(`A${layout.exWorksRow}`).value, 'I');
    assert.equal(sheet.getCell(`B${layout.exWorksRow}`).value, 'Total - Ex-Works');
    assert.equal(sheet.getCell(`B${layout.inlandRow}`).value, 'Inland Freight (Ex Works - Bangalore to Chennai Port, India)');
    assert.equal(sheet.getCell(`H${layout.inlandRow}`).value, 'Container');
    assert.equal(formulaOf(sheet.getCell(`L${layout.inlandRow}`)), `IF(OR(J${layout.inlandRow}="",K${layout.inlandRow}=""),"",ROUND(J${layout.inlandRow}*K${layout.inlandRow},2))`);
    assert.equal(formulaOf(sheet.getCell(`L${layout.fobRow}`)), `SUM(L${layout.exWorksRow},L${layout.inlandRow})`);
    assert.equal(sheet.getCell(`B${layout.fobRow}`).value, 'Total - FOB');
    assert.equal(sheet.getCell(`B${layout.oceanRow - 1}`).value, 'Freight Charges #');
    assert.equal(formulaOf(sheet.getCell(`L${layout.grandRow}`)), `SUM(L${layout.fobRow},L${layout.oceanRow})`);
    assert.equal(resultOf(sheet.getCell(`L${layout.grandRow}`)), 116621);
    assert.equal(sheet.getCell(`A${layout.grandRow}`).value, 'III');
    assert.equal(sheet.getCell(`A${layout.wordsRow}`).value, 'CFR VALUE (in Words):');
    assert.equal(formulaOf(sheet.getCell(`E${layout.wordsRow}`)), calc.wordsFormula(`$L$${layout.grandRow}`), 'words follow the grand total cell');
    assert.equal(resultOf(sheet.getCell(`E${layout.wordsRow}`)), totals.amount_in_words);
    assert.equal(sheet.getCell(`A${layout.figuresRow}`).value, 'CFR VALUE (in Figures):');
    assert.equal(formulaOf(sheet.getCell(`E${layout.figuresRow}`)), `$L$${layout.grandRow}`);
    assert.equal(sheet.getCell(`E${layout.figuresRow}`).numFmt, '"USD "#,##0.00');

    // Payment text and term 4 are formulas over the advance cell O3.
    assert.equal(sheet.getCell('O3').value, 10000);
    const payment = formulaOf(sheet.getCell('H16'));
    assert.ok(payment.includes('FIXED($O$3,2)') && payment.includes(`FIXED($L$${layout.grandRow}-$O$3,2)`), 'payment text quotes the advance and balance by formula');
    assert.equal(resultOf(sheet.getCell('H16')), 'Payment: USD 10,000.00 advance along with confirmed purchase order and the balance amount of USD 106,621.00 payable against a scanned copy of the draft Bill of Lading (B/L)');

    // Terms: 13 numbered rows, bold runs kept, tokens resolved.
    assert.equal(layout.termRows.length, 13);
    assert.equal(sheet.getCell(`A${layout.termsLabelRow}`).value, 'TERMS & CONDITIONS:');
    const termCell = (index) => sheet.getCell(`E${layout.termRows[index]}`);
    assert.equal(sheet.getCell(`B${layout.termRows[0]}`).value, 'Price Validity');
    assert.deepEqual(termCell(0).value.richText.map((run) => [run.text, Boolean(run.font.bold)]),
        [['The prices are ', false], ['valid', true], [' for 7 days from the date of Proforma Invoice.', false]]);
    assert.equal(termCell(1).value.richText.map((run) => run.text).join(''), 'CFR Alexandria Port, Egypt');
    assert.ok(formulaOf(termCell(3)).includes('FIXED($O$3,2)'), 'payment term follows the advance');
    assert.equal(resultOf(termCell(3)), 'USD 10,000.00 advance along with confirmed purchase order and the balance amount of USD 106,621.00 payable against a scanned copy of draft Bill of Lading (BL).');
    assert.equal(termCell(7).value.richText.map((run) => run.text).join(''), 'State Bank of India, Electronic City Branch, Bangalore, India\nAccount No.: 37365498723 SWIFT Code: SBININBBA32 IFSC: SBIN0063971');
    assert.ok(termCell(12).value.richText.map((run) => run.text).join('').includes('consignemnt'), 'supplied wording is not silently corrected');
    assert.ok(sheet.getRow(layout.termRows[9]).height > 12.75, 'multi-line terms get taller rows');

    // Signatures.
    assert.equal(sheet.getCell(`A${layout.signRow}`).value, 'Accepted By Buyer');
    assert.equal(sheet.getCell(`A${layout.signRow + 1}`).value, 'For ALFATTH IMPORT AND EXPORT FZ-LLC');
    assert.equal(sheet.getCell(`H${layout.signRow + 1}`).value, 'For Sudarshan Extrusions Pvt. Ltd.');
    assert.equal(sheet.getCell(`A${layout.lastRow}`).value, 'Authorised Signatory');
    assert.equal(sheet.getCell(`H${layout.lastRow}`).value, 'Authorised Signatory');
    assert.equal(sheet.getCell(`A${layout.lastRow}`).border.bottom.style, 'thin');

    // Print setup and calculation mode.
    assert.equal(sheet.pageSetup.paperSize, 9, 'A4');
    assert.equal(sheet.pageSetup.orientation, 'portrait');
    assert.equal(sheet.pageSetup.fitToPage, true);
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 1, 'the reference fits one page');
    const workbookXml = await (await JSZip.loadAsync(buffer)).file('xl/workbook.xml').async('string');
    assert.match(workbookXml, new RegExp(`Print_Area[^>]*>&apos;Proforma Invoice&apos;!\\$A\\$1:\\$L\\$${layout.lastRow}<`), 'print area is the whole invoice');
    assert.match(workbookXml, /<calcPr[^>]*fullCalcOnLoad="1"/, 'Excel recalculates on open');
    assert.doesNotMatch(workbookXml, /calcMode="(manual|autoNoTable)"/, 'calculation mode is automatic');
    assert.ok(workbook.worksheets.length === 1);
    assert.equal(exporter.exportFileName(sample), 'Proforma_Invoice_PI-03R5_2026-10-26.xlsx');

    // Every formula in the sheet is within Excel's limits.
    sheet.eachRow((row) => row.eachCell((cell) => {
        const formula = formulaOf(cell);
        if (!formula) return;
        assert.ok(formula.length < 8192, `${cell.address} formula length`);
        for (const literal of formula.match(/"(?:[^"]|"")*"/g) || []) assert.ok(literal.length <= 257, `${cell.address} string constant length`);
    }));

    // ── Rows added / removed / duplicated keep formulas intact ──
    const base = defaults.sampleInvoice();
    const many = sanitizeInvoice({
        ...base,
        items: [
            ...base.items,
            { ...base.items[0], id: 'dup' }, // duplicated row
            { ...base.items[1], id: 'sw', description: 'PVC Pipes - SWR Pipes', qty: 10, rate: 7.5 }, // second group
        ].concat(Array.from({ length: 25 }, (_, index) => ({ ...base.items[2], id: `bulk${index}`, description: 'PVC Pipes - SWR Pipes', qty: index + 1 }))),
        other_charges: withCharges.other_charges,
    });
    const manyTotals = calc.calculate(many);
    const big = await exporter.buildProformaWorkbook(many);
    const bigSheet = (await loadSheet(big.buffer)).sheet;
    const itemRows = [];
    for (let row = big.layout.firstItemRow; row <= big.layout.lastItemRow; row++) if (typeof bigSheet.getCell(`A${row}`).value === 'number') itemRows.push(row);
    assert.equal(itemRows.length, many.items.length, 'one numbered row per item');
    assert.deepEqual(itemRows.map((row) => bigSheet.getCell(`A${row}`).value), many.items.map((_, index) => index + 1), 'serial numbers run 1..n');
    assert.equal(bigSheet.getCell(`B${itemRows[7] - 1}`).value, 'PVC Pipes - SWR Pipes', 'a new group heading appears when the description changes');
    assert.equal(formulaOf(bigSheet.getCell(`L${big.layout.exWorksRow}`)), `SUM(L${big.layout.firstItemRow}:L${big.layout.lastItemRow})`);
    assert.equal(resultOf(bigSheet.getCell(`L${big.layout.exWorksRow}`)), manyTotals.ex_works);
    const [insRow, handRow, discRow] = big.layout.otherRows;
    assert.equal(formulaOf(bigSheet.getCell(`L${big.layout.grandRow}`)), `SUM(L${big.layout.fobRow},L${big.layout.oceanRow},L${insRow},L${discRow})`, 'excluded charge is not in the Grand Total');
    assert.equal(bigSheet.getCell(`B${handRow}`).value, 'Handling (buyer pays locally) (not included in Grand Total)');
    assert.equal(resultOf(bigSheet.getCell(`L${big.layout.grandRow}`)), manyTotals.grand_total);
    assert.equal(bigSheet.pageSetup.fitToHeight, 0, 'long invoices flow onto more pages');
    assert.equal(bigSheet.pageSetup.printTitlesRow, '22:22', 'table header repeats on every printed page');

    const single = sanitizeInvoice({ ...base, items: [base.items[3]], inland_freight: { include: false }, ocean_freight: { include: false } });
    const small = await exporter.buildProformaWorkbook(single);
    const smallSheet = (await loadSheet(small.buffer)).sheet;
    assert.equal(formulaOf(smallSheet.getCell(`L${small.layout.exWorksRow}`)), `SUM(L${small.layout.firstItemRow}:L${small.layout.lastItemRow})`);
    assert.equal(formulaOf(smallSheet.getCell(`L${small.layout.fobRow}`)), `L${small.layout.exWorksRow}`, 'FOB without inland freight');
    assert.equal(formulaOf(smallSheet.getCell(`L${small.layout.grandRow}`)), `L${small.layout.fobRow}`, 'Grand Total without ocean freight');
    assert.equal(resultOf(smallSheet.getCell(`L${small.layout.grandRow}`)), 22470);

    // ── Routes ───────────────────────────────────────────────
    const defaultsResponse = await api('GET', '/defaults');
    assert.equal(defaultsResponse.statusCode, 200);
    assert.equal(defaultsResponse.body.profile.exporter.gstin, '29AACCK1590L1Z6');
    assert.equal(defaultsResponse.body.blank.invoice.number, '', 'no hardcoded invoice number');
    assert.notEqual(defaultsResponse.body.blank.invoice.date, '2026-10-26', 'no hardcoded invoice date');
    assert.equal(defaultsResponse.body.blank.consignee.name, '', 'parties start empty');
    assert.equal(defaultsResponse.body.persistence, true);

    const previewResponse = await api('POST', '/preview', { body: { invoice: defaults.sampleInvoice() } });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.body.valid, true);
    assert.equal(previewResponse.body.totals.grand_total, 116621);
    assert.equal(previewResponse.body.texts.delivery_terms, 'CFR Alexandria Port, Egypt');
    assert.equal(previewResponse.body.texts.payment.dynamic, true);
    assert.equal(calc.segmentsToText(previewResponse.body.texts.payment.segments), resultOf(sheet.getCell('H16')), 'preview text equals the Excel cached text');

    const rejected = await api('POST', '/export', { body: { invoice: defaults.blankInvoice() } });
    assert.equal(rejected.statusCode, 422);
    assert.ok(rejected.body.errors['invoice.number']);
    const exported = await api('POST', '/export', { body: { invoice: defaults.sampleInvoice() } });
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.headers['content-disposition'], 'attachment; filename="Proforma_Invoice_PI-03R5_2026-10-26.xlsx"');
    assert.ok(Buffer.isBuffer(exported.body) && exported.body.length > 5000);

    // Save / list / load / update / delete, per user.
    const created = await api('POST', '/', { body: { invoice: defaults.sampleInvoice() } });
    assert.equal(created.statusCode, 201);
    const id = created.body.id;
    assert.equal(created.body.totals.grand_total, 116621);
    assert.equal(tables.proforma_invoices[0].user_id, USER_A);
    assert.equal(Number(tables.proforma_invoices[0].grand_total), 116621, 'list total is computed on the server');
    const clash = await api('POST', '/', { body: { invoice: defaults.sampleInvoice() } });
    assert.equal(clash.statusCode, 409, 'the same number cannot be saved twice');
    assert.match(clash.body.error, /already uses the number "Alfatth_26-27\/PI-03R5"/);
    const otherUser = await api('POST', '/', { user: USER_B, body: { invoice: defaults.sampleInvoice() } });
    assert.equal(otherUser.statusCode, 201, 'numbers are unique per user only');
    assert.equal((await api('GET', `/${id}`, { user: USER_B })).statusCode, 404, 'another user cannot read it');
    assert.equal((await api('PUT', `/${id}`, { user: USER_B, body: { invoice: defaults.blankInvoice() } })).statusCode, 404, 'another user cannot change it');
    assert.equal((await api('DELETE', `/${id}`, { user: USER_B })).statusCode, 404, 'another user cannot delete it');
    const draft = await api('POST', '/', { body: { invoice: defaults.blankInvoice() } });
    assert.equal(draft.statusCode, 201, 'an incomplete draft can be saved');
    assert.equal(draft.body.valid, false);
    const listed = await api('GET', '/', { query: { search: 'pmtech' } });
    assert.equal(listed.body.total, 1);
    assert.equal(listed.body.data[0].invoice_number, 'Alfatth_26-27/PI-03R5');
    const edited = defaults.sampleInvoice();
    edited.items[0].qty = 1000;
    const updated = await api('PUT', `/${id}`, { body: { invoice: edited } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.totals.grand_total, 109421);
    const loaded = await api('GET', `/${id}`);
    assert.equal(loaded.body.invoice.items[0].qty, 1000);

    // Next number: after PI-03R5 comes PI-04, per financial year.
    const next = await api('GET', '/next-number', { query: { prefix: 'Alfatth', date: '2026-10-27' } });
    assert.equal(next.body.number, 'Alfatth_26-27/PI-04');
    const nextYear = await api('GET', '/next-number', { query: { prefix: 'Alfatth', date: '2027-04-01' } });
    assert.equal(nextYear.body.number, 'Alfatth_27-28/PI-01', 'numbering restarts each April');
    const otherPrefix = await api('GET', '/next-number', { query: { prefix: 'PMtech', date: '2026-10-27' } });
    assert.equal(otherPrefix.body.number, 'PMtech_26-27/PI-01');

    // Profile: saved per user and used for new invoices.
    const profile = sanitizeProfile({ ...defaults.DEFAULT_PROFILE, bank: { ...defaults.DEFAULT_PROFILE.bank, account: '11112222333' } });
    assert.equal((await api('PUT', '/profile', { body: { profile } })).statusCode, 200);
    const afterProfile = await api('GET', '/defaults');
    assert.equal(afterProfile.body.blank.bank.account, '11112222333', 'new invoices use the saved bank details');
    assert.equal((await api('GET', '/defaults', { user: USER_B })).body.blank.bank.account, '37365498723', 'other users keep their own profile');

    assert.equal((await api('DELETE', `/${id}`)).statusCode, 200);
    assert.equal((await api('GET', `/${id}`)).statusCode, 404);

    // ── Before the migration: preview/export work, saving explains why not ──
    missingTables = true;
    const offlineDefaults = await api('GET', '/defaults');
    assert.equal(offlineDefaults.statusCode, 200);
    assert.equal(offlineDefaults.body.persistence, false);
    assert.equal((await api('POST', '/preview', { body: { invoice: defaults.sampleInvoice() } })).statusCode, 200);
    assert.equal((await api('POST', '/export', { body: { invoice: defaults.sampleInvoice() } })).statusCode, 200);
    const offlineSave = await api('POST', '/', { body: { invoice: defaults.sampleInvoice() } });
    assert.equal(offlineSave.statusCode, 503);
    assert.equal(offlineSave.body.code, 'PROFORMA_MIGRATION_PENDING');
    assert.match(offlineSave.body.error, /supabase-proforma-migration\.sql/);
    missingTables = false;

    console.log('proforma-smoke: all checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
