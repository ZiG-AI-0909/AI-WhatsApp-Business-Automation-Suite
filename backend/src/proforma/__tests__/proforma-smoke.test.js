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
    // ── Calculation on the signed sample invoice (PI-04) ─────────────────
    const sample = sanitizeInvoice(defaults.sampleInvoice());
    const totals = calc.calculate(sample);
    assert.deepEqual(totals.items.map((item) => item.amount), [17200, 28785, 11225, 22470, 9500, 4941], 'reference line amounts');
    assert.equal(totals.total_qty, 5648, 'reference total quantity');
    assert.equal(totals.ex_works, 94121);
    assert.equal(totals.inland_freight, 3300);
    assert.equal(totals.fob, 97421);
    assert.equal(totals.ocean_freight, 19200);
    assert.equal(totals.grand_total, 116621);
    assert.equal(totals.balance, 86621, 'balance = grand total - advance');
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

    // ── Excel: layout replicating the signed sample (PI-04) ──
    const { buffer, layout } = await exporter.buildProformaWorkbook(sample);
    const { workbook, sheet } = await loadSheet(buffer);
    const text = (address) => {
        const value = sheet.getCell(address).value;
        return value?.richText ? value.richText.map((run) => run.text).join('') : value;
    };
    const boldRuns = (address) => sheet.getCell(address).value.richText.filter((run) => run.font?.bold).map((run) => run.text);
    assert.equal(sheet.getImages().length, 1, 'letterhead logo above the title');
    assert.equal(layout.titleRow, 2);
    assert.equal(text('A2'), 'PROFORMA INVOICE');
    assert.equal(sheet.getCell('A2').font.bold, true);
    assert.equal(text('A3'), 'Manufacturer & Exporter:');
    assert.equal(text('A4'), 'M/s. Sudarshan Extrusions Pvt. Ltd.');
    assert.equal(text('A5'), '105, Phase IV, Bommasandra Industrial Area, Hosur Road');
    assert.equal(text('A6'), 'Bangalore - 560099, Karnataka, India');
    assert.equal(text('A7'), 'GSTIN: 29AACCK1590L1Z6 | IEC: 0705014487');
    assert.deepEqual(boldRuns('A7'), ['GSTIN: ', 'IEC: '], 'labels bold, values plain, as printed');
    assert.equal(text('A8'), 'Contact: Aayush +91 97423 50063 | Sunil +91 93422 39695');
    assert.equal(text('H4'), 'Alfatth_26-27/PI-04');
    assert.deepEqual(sheet.getCell('H5').value.richText.map((run) => run.text), ['Dated: 27', 'th', ' October 2026']);
    assert.equal(sheet.getCell('H5').value.richText[1].font.vertAlign, 'superscript', '"th" is superscript as in the sample');
    assert.equal(text('H7'), "Buyer's Enquiry / Purchase Order No. & Date");
    assert.equal(text('H8'), 'Ref: WhatsApp correspondence & telephonic discussion');
    assert.equal(text('A10'), 'PMtech Water Solutions');
    assert.equal(text('A11'), 'K28, Plot 39-Abu Rawash Industrial Zone, Giza, Egypt', 'country not repeated when the address ends with it');
    assert.equal(text('A12'), 'Tax Registration Number: 757121691');
    assert.equal(text('A13'), 'ACID No.: To be provided by Buyer prior to the shipment.');
    assert.equal(text('A14'), 'Email ID: Abdelhamed@pmtech-egypt.com | Tel. +20 10 0439 6443');
    assert.equal(text('H10'), 'ALFATTH Import and Export FZ-LLC');
    assert.equal(text('H11'), 'A2-1505A, Building no. A2, Al Hamra Industrial Zone-FZ');
    assert.equal(text('H12'), 'Ras Al Khaimah, UAE');
    assert.equal(text('H13'), 'Tax Registration Number: 104817492200001');
    assert.equal(text('H14'), 'Emailid: Abdelhamed@alfatth-uae.com | Tel. +971 54 733 1749');
    assert.equal(text('H15'), 'Country of Origin of Goods');
    assert.equal(text('H16'), 'INDIA');
    assert.equal(text('K16'), 'EGYPT');
    assert.equal(text('A16'), 'Road');
    assert.equal(text('D16'), 'Bangalore / Chennai, India');
    assert.equal(text('A17'), 'Container No.');
    assert.equal(text('A19'), 'Vessel / Flight No.');
    assert.equal(text('D18'), 'Chennai / Ennore / Katupalli Port, India');
    assert.equal(text('H18'), 'Delivery: CFR Alexandria Port, Egypt');
    assert.equal(text('A20'), 'Port of Discharge');
    assert.equal(text('D20'), 'Final Destination');
    assert.equal(text('A21'), 'Alexandria Port, Egypt');
    assert.equal(text('D21'), 'Giza, Egypt');
    assert.equal(sheet.getCell('H21').font.underline, true);
    assert.equal(text('H22'), 'State Bank of India, Electronic City Branch, Bangalore, India');
    assert.equal(text('H23'), 'A/c No.: 37365498723 SWIFT Code: SBININBBA32 IFSC: SBIN0063971');
    assert.deepEqual(boldRuns('H23'), ['37365498723', 'SBININBBA32']);

    const merges = sheet.model.merges;
    for (const range of ['A2:L2', 'A3:G3', 'H3:L3', 'H5:L6', 'A9:G9', 'H9:L9', 'A15:C15', 'D15:G15', 'H15:J15', 'K15:L15', 'D18:G19', 'H19:L20', 'A21:C23', 'D21:G23', 'B24:G24']) {
        assert.ok(merges.includes(range), `merged ${range}`);
    }
    assert.equal(layout.headerRow, 24);
    assert.deepEqual(['A', 'B', 'H', 'I', 'J', 'K', 'L'].map((column) => text(`${column}24`)),
        ['Sl. No.', 'Description of Goods', 'Length per Piece', 'H S Code', 'Quantity (Pieces)', 'Unit Price (USD / Piece)', 'Amount (USD)']);
    const widthsPx = sheet.columns.slice(0, 12).map((column) => Math.round(column.width * 7 + 5));
    assert.deepEqual(widthsPx, exporter.COLUMN_PX, 'column widths match the reference (px)');
    assert.equal(sheet.getCell('A24').border.top.style, 'thin', 'table header is boxed');
    assert.equal(sheet.getCell('H3').border.left.style, 'thin', 'vertical divider between the two header halves');

    // Group heading + items.
    const first = layout.firstItemRow;
    assert.equal(first, 25);
    assert.equal(text(`B${first}`), 'PVC Pipes - uPVC Column Pipes');
    assert.equal(sheet.getCell(`B${first}`).font.bold, true);
    assert.deepEqual(['A', 'B', 'C', 'F', 'G', 'H', 'I', 'J', 'K'].map((column) => text(`${column}${first + 1}`)),
        [1, '3"', 'Super Deluxe / Standard', '17 kgf/cm²', '(Standard Coupler)', 3, '39172390', 1720, 10]);
    assert.equal(sheet.getCell(`H${first + 1}`).numFmt, '0.0" Mtr."', 'length shows as "3.0 Mtr." but stays numeric');
    for (let row = first + 1; row <= first + 6; row++) {
        assert.equal(formulaOf(sheet.getCell(`L${row}`)), `IF(OR(J${row}="",K${row}=""),"",ROUND(J${row}*K${row},2))`, `amount formula row ${row}`);
    }
    assert.equal(resultOf(sheet.getCell(`L${first + 2}`)), 28785);
    assert.equal(formulaOf(sheet.getCell(`J${layout.exWorksRow}`)), `SUM(J${first}:J${layout.lastItemRow})`);
    assert.equal(formulaOf(sheet.getCell(`L${layout.exWorksRow}`)), `SUM(L${first}:L${layout.lastItemRow})`);
    assert.equal(resultOf(sheet.getCell(`L${layout.exWorksRow}`)), 94121);
    assert.equal(text(`A${layout.exWorksRow}`), 'I');
    assert.equal(text(`B${layout.exWorksRow}`), 'Total - Ex-Works');
    assert.equal(text(`B${layout.inlandRow}`), 'Inland Freight (Ex Works - Bangalore to Chennai Port, India)');
    assert.equal(text(`H${layout.inlandRow}`), 'Container');
    assert.equal(formulaOf(sheet.getCell(`L${layout.inlandRow}`)), `IF(OR(J${layout.inlandRow}="",K${layout.inlandRow}=""),"",ROUND(J${layout.inlandRow}*K${layout.inlandRow},2))`);
    assert.equal(formulaOf(sheet.getCell(`L${layout.fobRow}`)), `SUM(L${layout.exWorksRow},L${layout.inlandRow})`);
    assert.equal(text(`B${layout.fobRow}`), 'Total - FOB Value');
    assert.equal(text(`B${layout.oceanRow - 1}`), 'Freight Charges #');
    assert.equal(formulaOf(sheet.getCell(`L${layout.grandRow}`)), `SUM(L${layout.fobRow},L${layout.oceanRow})`);
    assert.equal(resultOf(sheet.getCell(`L${layout.grandRow}`)), 116621);
    assert.equal(text(`A${layout.grandRow}`), 'III');
    assert.equal(text(`B${layout.grandRow}`), 'Total - CFR Value');
    assert.equal(text(`A${layout.wordsRow}`), 'Amount in Words:');
    assert.equal(formulaOf(sheet.getCell(`E${layout.wordsRow}`)), calc.wordsFormula(`$L$${layout.grandRow}`), 'words follow the total cell');
    assert.equal(resultOf(sheet.getCell(`E${layout.wordsRow}`)), totals.amount_in_words);
    assert.equal(layout.termsLabelRow, layout.wordsRow + 1, 'no separate "in figures" row, as in the sample');

    // Payment text is a formula over the advance cell O3 and the total.
    assert.equal(sheet.getCell('O3').value, 30000);
    assert.equal(layout.paymentCell, 'H19');
    const payment = formulaOf(sheet.getCell('H19'));
    assert.ok(payment.includes('FIXED($O$3,2)') && payment.includes(`FIXED($L$${layout.grandRow}-$O$3,2)`), 'payment text quotes the advance and balance by formula');
    assert.ok(payment.includes('&CHAR(10)&'), 'the two payment lines are kept');
    assert.equal(resultOf(sheet.getCell('H19')), 'Payment: USD 30,000.00 advance on PI acceptance & order confirmation.\nBalance USD 86,621.00 payable against draft BL copy.');

    // Terms: 13 numbered rows, bold runs kept, tokens resolved.
    assert.equal(layout.termRows.length, 13);
    assert.equal(text(`A${layout.termsLabelRow}`), 'TERMS & CONDITIONS:');
    const termCell = (index) => sheet.getCell(`E${layout.termRows[index]}`);
    const termText = (index) => termCell(index).value.richText.map((run) => run.text).join('');
    assert.equal(text(`B${layout.termRows[0]}`), 'Price Validity');
    assert.deepEqual(termCell(0).value.richText.map((run) => [run.text, Boolean(run.font.bold)]),
        [['Pirce ', false], ['valid', true], [' for 7 days from Proforma Invoice Date.', false]]);
    assert.equal(text(`B${layout.termRows[2]}`), 'Incoterms ® 2020');
    assert.equal(termText(2), 'CFR Alexandria Port, Egypt. Risk in the goods passes from seller to buyer once the goods are loaded on board the vessel at the Port of Loading.');
    assert.ok(termText(3).includes('not included in the CFR Price'), 'Incoterm placeholder resolved');
    assert.equal(termText(7), 'State Bank of India, Electronic City Branch, Bangalore, India\nAccount No.: 37365498723 SWIFT Code: SBININBBA32 IFSC: SBIN0063971');
    assert.ok(termText(11).includes('incldiung'), 'supplied wording is not silently corrected');
    assert.ok(sheet.getRow(layout.termRows[8]).height > 12.75, 'multi-line terms get taller rows');

    // Signatures and the letterhead footer.
    assert.equal(text(`A${layout.signRow}`), 'Accepted By Buyer');
    assert.equal(text(`A${layout.signRow + 1}`), 'For ALFATTH IMPORT & EXPORT FZ-LLC', 'buyer signature name as printed');
    assert.equal(text(`H${layout.signRow + 1}`), 'For Sudarshan Extrusions Pvt. Ltd.');
    const signatureRow = layout.signRow + 6;
    assert.equal(text(`A${signatureRow}`), 'Authorised Signatory');
    assert.equal(text(`H${signatureRow}`), 'Authorised Signatory');
    assert.equal(sheet.getCell(`A${signatureRow}`).border.bottom.style, 'thin');
    assert.deepEqual([layout.lastRow - 2, layout.lastRow - 1, layout.lastRow].map((row) => text(`A${row}`)), [
        'SUDARSHAN EXTRUSIONS PVT. LTD.',
        '#105, Phase IV, Bommasandra Industrial Area, Hosur Road, Bangalore, Karnataka - 560099',
        'sales@sudarshanpipes.com || www.sudarshanpipes.com',
    ]);
    assert.equal(sheet.getCell(`A${layout.lastRow}`).fill.fgColor.argb, 'FFE8732A', 'orange footer band');

    // Print setup and calculation mode.
    assert.equal(sheet.pageSetup.paperSize, 9, 'A4');
    assert.equal(sheet.pageSetup.orientation, 'portrait');
    assert.equal(sheet.pageSetup.fitToPage, true);
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 1, 'the sample fits one page');
    const workbookXml = await (await JSZip.loadAsync(buffer)).file('xl/workbook.xml').async('string');
    assert.match(workbookXml, new RegExp(`Print_Area[^>]*>&apos;Proforma Invoice&apos;!\\$A\\$1:\\$L\\$${layout.lastRow}<`), 'print area is the whole invoice, footer included');
    assert.match(workbookXml, /<calcPr[^>]*fullCalcOnLoad="1"/, 'Excel recalculates on open');
    assert.doesNotMatch(workbookXml, /calcMode="(manual|autoNoTable)"/, 'calculation mode is automatic');
    assert.ok(workbook.worksheets.length === 1);
    assert.equal(exporter.exportFileName(sample), 'Proforma_Invoice_PI-04_2026-10-27.xlsx');

    // Letterhead off: no logo row, no footer band.
    const plainInvoice = sanitizeInvoice({ ...defaults.sampleInvoice(), letterhead: { show_logo: false, footer_title: '', footer_address: '', footer_contact: '' } });
    const plain = await exporter.buildProformaWorkbook(plainInvoice);
    const plainSheet = (await loadSheet(plain.buffer)).sheet;
    assert.equal(plainSheet.getImages().length, 0);
    assert.equal(plain.layout.titleRow, 1);
    assert.equal(plainSheet.getCell(`A${plain.layout.lastRow}`).value, 'Authorised Signatory');

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
    assert.equal(bigSheet.pageSetup.printTitlesRow, '24:24', 'table header repeats on every printed page');

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
    assert.notEqual(defaultsResponse.body.blank.invoice.date, '2026-10-27', 'no hardcoded invoice date');
    assert.equal(defaultsResponse.body.blank.consignee.name, '', 'parties start empty');
    assert.equal(defaultsResponse.body.persistence, true);

    const previewResponse = await api('POST', '/preview', { body: { invoice: defaults.sampleInvoice() } });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.body.valid, true);
    assert.equal(previewResponse.body.totals.grand_total, 116621);
    assert.equal(previewResponse.body.texts.delivery_terms, 'CFR Alexandria Port, Egypt');
    assert.equal(previewResponse.body.texts.payment.dynamic, true);
    assert.equal(calc.segmentsToText(previewResponse.body.texts.payment.segments), resultOf(sheet.getCell(layout.paymentCell)), 'preview text equals the Excel cached text');

    const rejected = await api('POST', '/export', { body: { invoice: defaults.blankInvoice() } });
    assert.equal(rejected.statusCode, 422);
    assert.ok(rejected.body.errors['invoice.number']);
    const exported = await api('POST', '/export', { body: { invoice: defaults.sampleInvoice() } });
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.headers['content-disposition'], 'attachment; filename="Proforma_Invoice_PI-04_2026-10-27.xlsx"');
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
    assert.match(clash.body.error, /already uses the number "Alfatth_26-27\/PI-04"/);
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
    assert.equal(listed.body.data[0].invoice_number, 'Alfatth_26-27/PI-04');
    const edited = defaults.sampleInvoice();
    edited.items[0].qty = 1000;
    const updated = await api('PUT', `/${id}`, { body: { invoice: edited } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.totals.grand_total, 109421);
    const loaded = await api('GET', `/${id}`);
    assert.equal(loaded.body.invoice.items[0].qty, 1000);

    // Next number: after PI-04 comes PI-05, per financial year.
    const next = await api('GET', '/next-number', { query: { prefix: 'Alfatth', date: '2026-10-27' } });
    assert.equal(next.body.number, 'Alfatth_26-27/PI-05');
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
