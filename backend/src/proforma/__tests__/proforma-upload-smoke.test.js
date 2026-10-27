// =============================================================
// Smoke test — Proforma upload -> auto-fill (OCR, then AI extraction).
//
// OCR (ai/ocrService, documents/pdfOcr, pdf-parse), the AI client
// (routes/boq loadExtractionClient), multer and Supabase are stubbed before
// the router loads. The AI response is a fixture for the reference invoice
// (fixtures/reference-extraction.json, numbers deliberately as messy strings
// such as "1,720", "3.0 Mtr.", "1,16,621.00").
//
// Covers: the reference round-trips field by field into the form and into
// the Excel export with working formulas; numbers parse strictly (bad digits
// are flagged, never guessed); quantity x price is checked against the
// document's amounts; amounts in payment wording become live placeholders;
// the document's own inconsistent totals are reported; OCR and extraction
// run as two requests with independent budgets; empty OCR and non-invoices
// are rejected with clear messages; PDF text layer / scanned path / page cap.
//
// Run: node backend/src/proforma/__tests__/proforma-upload-smoke.test.js
// =============================================================
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

process.env.PROFORMA_OCR_BUDGET_MS = '70000';
process.env.PROFORMA_EXTRACT_BUDGET_MS = '90000';

const OCR_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures/reference-ocr.txt'), 'utf8');
const EXTRACTION = fs.readFileSync(path.join(__dirname, 'fixtures/reference-extraction.json'), 'utf8');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

function stub(modulePath, exports) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Supabase: no saved profile (factory defaults).
const emptyQuery = () => {
    const api = { select: () => api, eq: () => api, limit: () => api, maybeSingle: async () => ({ data: null, error: null }), then: (resolve) => resolve({ data: [], error: null }) };
    return api;
};
stub('../../database/supabaseClient', { supabase: { from: emptyQuery }, isAvailable: () => true });
const pass = (_req, _res, next) => next();
stub('../../middleware/rateLimiterMiddleware', { aiExtractLimiter: pass, mutationLimiter: pass, sendLimiter: pass, aiQueryLimiter: pass, webhookLimiter: pass });
// multer: the test puts req.file on the request itself.
const fakeMulter = () => ({ single: () => (_req, _res, callback) => callback() });
fakeMulter.memoryStorage = () => ({});
stub('multer', fakeMulter);

const calls = { ocr: [], pdfOcr: [], ai: [] };
let ocrResult = OCR_TEXT;
stub('../../ai/ocrService', { ocrImage: async (buffer, options) => { calls.ocr.push({ at: Date.now(), options }); return ocrResult; } });
let scannedText = OCR_TEXT;
stub('../../documents/pdfOcr', { ocrScannedPdf: async (buffer, userId, options) => { calls.pdfOcr.push({ at: Date.now(), options }); return { text: scannedText, failedPages: [] }; } });
let pdfLayer = { total: 1, text: '-- 1 of 1 --' };
stub('pdf-parse', { PDFParse: class { async getText() { return pdfLayer; } async destroy() {} } });
let aiReply = () => `<think>The user wants JSON {"items": []}</think>\n\`\`\`json\n${EXTRACTION}\n\`\`\``;
stub('../../routes/boq', {
    loadExtractionClient: async () => ({
        aiConfig: { apiKey: 'test', baseURL: 'http://ai.invalid' },
        model: 'test-model',
        aiService: { _complete: async (messages, options) => { calls.ai.push({ at: Date.now(), messages, options }); return aiReply(); } },
    }),
});

const defaults = require('../proformaDefaults');
const calc = require('../proformaCalculation');
const extractor = require('../proformaExtractor');
const { validateInvoice } = require('../proformaValidation');
const exporter = require('../proformaExport');
const router = require('../../routes/proforma');

async function api(method, routePath, { body = {}, file = null } = {}) {
    const layer = router.stack.find((entry) => entry.route?.methods[method.toLowerCase()] && entry.match(routePath));
    assert.ok(layer, `route ${method} ${routePath} exists`);
    const req = { method, params: layer.params, body, query: {}, file, user: { id: 'user-1' }, headers: {} };
    const response = { statusCode: 200, body: undefined };
    const res = {
        status(code) { response.statusCode = code; return res; },
        json(payload) { response.body = payload; return res; },
        send(payload) { response.body = payload; return res; },
        type() { return res; },
        setHeader() {},
    };
    for (const step of layer.route.stack) {
        let advanced = false;
        await step.handle(req, res, () => { advanced = true; });
        if (!advanced) break;
    }
    return response;
}

const formulaOf = (cell) => cell.value?.formula || null;

async function run() {
    // ── Pure: strict numbers ─────────────────────────────────
    assert.equal(extractor.parseNumber('1,16,621.00'), 116621);
    assert.equal(extractor.parseNumber('USD 10,000.00'), 10000);
    assert.equal(extractor.parseNumber('3.0 Mtr.'), 3);
    assert.equal(extractor.parseNumber('₹ 1,100'), 1100);
    assert.equal(extractor.parseNumber('(50.00)'), -50);
    assert.equal(extractor.parseNumber('1,72O'), null, 'an OCR letter O is not read as a zero');
    assert.equal(extractor.parseNumber('10.00.00'), null);
    assert.equal(extractor.parseNumber(''), null);
    assert.equal(extractor.parseJsonObject('noise {"a":1} trailing').a, 1);
    assert.throws(() => extractor.parseJsonObject('no json here'), /structured invoice data/);

    // ── Reference extraction -> form ─────────────────────────
    const blank = defaults.blankInvoice(defaults.DEFAULT_PROFILE, '2026-10-27');
    const mapped = extractor.mapExtraction(JSON.parse(EXTRACTION), blank);
    const invoice = mapped.invoice;
    const sample = defaults.sampleInvoice();
    for (const section of ['exporter', 'consignee', 'bank']) {
        for (const [field, value] of Object.entries(sample[section])) {
            if (field === 'signatory_name') continue;
            assert.equal(invoice[section][field], value, `${section}.${field} round-trips`);
        }
    }
    for (const field of ['name', 'address', 'country', 'tax_id', 'email', 'phone']) assert.equal(invoice.buyer[field], sample.buyer[field], `buyer.${field}`);
    for (const [field, value] of Object.entries(sample.shipping)) {
        if (field !== 'delivery_terms') assert.equal(invoice.shipping[field], value, `shipping.${field}`);
    }
    assert.equal(invoice.invoice.number, 'Alfatth_26-27/PI-03R5');
    assert.equal(invoice.invoice.date, '2026-10-26');
    assert.equal(invoice.invoice.currency, 'USD');
    assert.equal(invoice.items.length, 6);
    invoice.items.forEach((item, index) => {
        const expected = sample.items[index];
        for (const field of ['description', 'size', 'specification', 'pressure', 'coupler', 'hsn']) assert.equal(item[field], expected[field], `item ${index + 1} ${field}`);
        for (const field of ['length', 'qty', 'rate']) {
            assert.equal(typeof item[field], 'number', `item ${index + 1} ${field} is a number, not a string`);
            assert.equal(item[field], expected[field], `item ${index + 1} ${field}`);
        }
    });
    assert.equal(invoice.items[1].description, 'PVC Pipes - uPVC Column Pipes', 'the group heading carries down to rows without one');
    assert.deepEqual([invoice.inland_freight.qty, invoice.inland_freight.rate, invoice.ocean_freight.qty, invoice.ocean_freight.rate], [3, 1100, 3, 6400]);
    assert.equal(invoice.payment.advance, 10000);
    assert.equal(invoice.payment.summary, 'Payment: {currency} {advance} advance along with confirmed purchase order and the balance amount of {currency} {balance} payable against a scanned copy of the draft Bill of Lading (B/L)');
    assert.equal(invoice.terms.length, 13);
    assert.equal(invoice.terms[3].text, '{currency} {advance} advance along with confirmed purchase order and the balance amount of {currency} {balance} payable against a scanned copy of draft Bill of Lading (BL).');
    assert.equal(invoice.terms[12].text, sample.terms[12].text.replace(/\*\*/g, ''), 'terms are kept verbatim (spelling included)');

    assert.deepEqual(validateInvoice(invoice), {}, 'the auto-filled invoice is ready to export');
    const totals = calc.calculate(invoice);
    assert.equal(totals.grand_total, 116621);
    assert.equal(totals.balance, 106621);

    // Flags: low confidence, replaced amounts, and the document's own
    // inconsistent CFR figure / balance; none on the clean product rows.
    assert.match(mapped.flags['consignee.tax_id'], /low confidence/);
    assert.match(mapped.flags['payment.summary'], /live \{advance\}\/\{balance\}/);
    assert.match(mapped.flags[`terms.${invoice.terms[3].id}.text`], /live/);
    assert.ok(mapped.warnings.some((warning) => /value in figures is 39,166\.00, but the extracted rows add up to 116,621\.00/.test(warning)), 'the reference CFR figure mismatch is reported');
    assert.ok(mapped.warnings.some((warning) => /payment balance is 29,166\.00, but Grand Total − advance is 106,621\.00/.test(warning)));
    assert.ok(!Object.keys(mapped.flags).some((key) => key.startsWith('items.')), 'clean rows carry no flags');
    assert.ok(!mapped.flags['invoice.number'] && !mapped.flags['exporter.name']);
    assert.deepEqual(mapped.document_totals, { ex_works: 94121, fob: 97421, grand_total: 116621, value_in_figures: 39166, balance: 29166 }, 'printed totals are returned for the live re-check');

    // ── Round trip into Excel with working formulas ──────────
    const { buffer, layout } = await exporter.buildProformaWorkbook(invoice);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Proforma Invoice');
    assert.equal(sheet.getCell('H3').value, 'Alfatth_26-27/PI-03R5');
    assert.equal(sheet.getCell('A9').value, 'PMtech Water Solutions');
    assert.equal(sheet.getCell('H9').value, 'ALFATTH Import and Export FZ-LLC');
    assert.equal(sheet.getCell('H15').value, 'CFR Alexandria Port, Egypt');
    for (let row = 24; row <= 29; row++) {
        assert.equal(typeof sheet.getCell(`J${row}`).value, 'number', `J${row} quantity is numeric in Excel`);
        assert.equal(typeof sheet.getCell(`K${row}`).value, 'number', `K${row} price is numeric in Excel`);
        assert.equal(formulaOf(sheet.getCell(`L${row}`)), `IF(OR(J${row}="",K${row}=""),"",ROUND(J${row}*K${row},2))`);
    }
    assert.equal(sheet.getCell(`L${layout.grandRow}`).value.result, 116621);
    assert.equal(formulaOf(sheet.getCell(`L${layout.grandRow}`)), `SUM(L${layout.fobRow},L${layout.oceanRow})`);
    assert.equal(sheet.getCell('O3').value, 10000);
    assert.match(formulaOf(sheet.getCell('H16')), /FIXED\(\$O\$3,2\).*FIXED\(\$L\$35-\$O\$3,2\)/);
    assert.equal(sheet.getCell('H16').value.result, 'Payment: USD 10,000.00 advance along with confirmed purchase order and the balance amount of USD 106,621.00 payable against a scanned copy of the draft Bill of Lading (B/L)');
    assert.equal(sheet.getCell(`E${layout.wordsRow}`).value.result, 'United States Dollars One Hundred Sixteen Thousand Six Hundred Twenty One and Zero Cents only.');

    // ── Messy readings are flagged, not guessed ──────────────
    const messy = JSON.parse(EXTRACTION);
    messy.items[0].quantity = '1,72O';
    messy.items[1].unit_price = 15.25; // document amount 28,785 says 14.25
    messy.items[2].specification = null;
    messy.items[2].size = null;
    messy.consignee.name = null;
    messy.invoice.date = '26/10/2026';
    messy.payment.advance_amount = null;
    messy.terms = [];
    const messyResult = extractor.mapExtraction(messy, blank);
    const [first, second, third] = messyResult.invoice.items;
    assert.equal(first.qty, '', 'unreadable quantity is left empty, not zero');
    assert.match(messyResult.flags[`items.${first.id}.qty`], /Could not read the quantity "1,72O"/);
    assert.match(messyResult.flags[`items.${second.id}.rate`], /Quantity × price = 30,805\.00, but the document shows 28,785\.00/);
    assert.match(messyResult.flags[`items.${third.id}.specification`], /Not found/);
    assert.match(messyResult.flags['consignee.name'], /Not found/);
    assert.match(messyResult.flags['invoice.date'], /Could not read the date "26\/10\/2026"/);
    assert.match(messyResult.flags['payment.advance'], /Advance amount not found/);
    assert.match(messyResult.flags.terms, /standard terms were kept/);
    assert.equal(messyResult.invoice.terms.length, 13, 'standard terms kept');
    const messyErrors = validateInvoice(messyResult.invoice);
    assert.ok(messyErrors[`items.${first.id}.qty`] && messyErrors['consignee.name'], 'export stays blocked until the flagged fields are filled');

    // Exporter not on the document: kept from the profile and flagged.
    const noExporter = JSON.parse(EXTRACTION);
    noExporter.exporter = {};
    const kept = extractor.mapExtraction(noExporter, blank);
    assert.equal(kept.invoice.exporter.gstin, '29AACCK1590L1Z6');
    assert.match(kept.flags['exporter.gstin'], /kept from your saved company details/);

    // ── Routes: two steps, independent budgets ───────────────
    const ocr = await api('POST', '/upload/ocr', { file: { buffer: PNG, originalname: 'invoice.png' } });
    assert.equal(ocr.statusCode, 200);
    assert.equal(ocr.body.source, 'ocr');
    assert.equal(ocr.body.text, OCR_TEXT);
    assert.equal(calls.ocr.length, 1, 'a single image is one OCR call');
    assert.equal(calls.ocr[0].options.timeoutMs, 70000, 'OCR gets its own budget');
    assert.equal(calls.ai.length, 0, 'OCR does not start the AI step');

    await new Promise((resolve) => setTimeout(resolve, 30));
    const extract = await api('POST', '/upload/extract', { body: { text: ocr.body.text } });
    assert.equal(extract.statusCode, 200);
    const aiCall = calls.ai[0];
    assert.ok(Math.abs(aiCall.options.deadlineMs - aiCall.at - 90000) < 1000, 'extraction gets its own full budget, untouched by OCR time');
    assert.equal(aiCall.options.timeoutMs, 90000);
    assert.ok(aiCall.messages[0].content.includes('Alfatth_26-27/PI-03R5'), 'the OCR text is in the prompt');
    assert.equal(extract.body.invoice.items.length, 6);
    assert.equal(extract.body.totals.grand_total, 116621);
    assert.equal(extract.body.valid, true);
    assert.ok(extract.body.flags['consignee.tax_id']);
    assert.ok(extract.body.warnings.length >= 2);

    // Extraction timeout: retryable, OCR text not needed again.
    const okReply = aiReply;
    aiReply = () => { throw Object.assign(new Error('AI request timed out'), { aiKind: 'timeout' }); };
    const timedOut = await api('POST', '/upload/extract', { body: { text: OCR_TEXT } });
    assert.equal(timedOut.statusCode, 504);
    assert.equal(timedOut.body.retryable, true);
    assert.match(timedOut.body.error, /does not need to be read again/);

    // Not a proforma invoice.
    aiReply = () => JSON.stringify({ is_proforma_invoice: false, items: [] });
    const notInvoice = await api('POST', '/upload/extract', { body: { text: 'Dear Sir, please find our company brochure attached. Regards, Sales Team, Bangalore office.' } });
    assert.equal(notInvoice.statusCode, 422);
    assert.equal(notInvoice.body.code, 'NOT_A_PROFORMA');
    aiReply = () => JSON.stringify({ is_proforma_invoice: true, invoice: {}, items: [], terms: [] });
    assert.equal((await api('POST', '/upload/extract', { body: { text: OCR_TEXT } })).body.code, 'NOT_A_PROFORMA', 'an empty extraction is not used to fill the form');
    aiReply = () => 'Sorry, I cannot help with that.';
    const garbage = await api('POST', '/upload/extract', { body: { text: OCR_TEXT } });
    assert.equal(garbage.statusCode, 502);
    assert.equal(garbage.body.retryable, true);
    aiReply = okReply;

    // OCR found no text.
    ocrResult = '  \n ';
    const blankScan = await api('POST', '/upload/ocr', { file: { buffer: PNG, originalname: 'blank.png' } });
    assert.equal(blankScan.statusCode, 422);
    assert.equal(blankScan.body.code, 'NO_TEXT');
    ocrResult = OCR_TEXT;

    // Wrong content / missing file.
    assert.equal((await api('POST', '/upload/ocr', { file: { buffer: PDF, originalname: 'invoice.png' } })).statusCode, 400);
    assert.equal((await api('POST', '/upload/ocr', {})).statusCode, 400);
    assert.equal((await api('POST', '/upload/extract', { body: { text: '' } })).statusCode, 400);

    // PDFs: text layer used directly; scanned PDF goes to OCR with this step's deadline; page cap.
    pdfLayer = { total: 1, text: OCR_TEXT };
    const textPdf = await api('POST', '/upload/ocr', { file: { buffer: PDF, originalname: 'invoice.pdf' } });
    assert.equal(textPdf.body.source, 'pdf_text');
    assert.equal(calls.pdfOcr.length, 0, 'no OCR spend for a PDF with a text layer');
    pdfLayer = { total: 2, text: '-- 1 of 2 --\n-- 2 of 2 --' };
    const scanned = await api('POST', '/upload/ocr', { file: { buffer: PDF, originalname: 'scan.pdf' } });
    assert.equal(scanned.statusCode, 200);
    assert.equal(scanned.body.source, 'ocr');
    assert.ok(Math.abs(calls.pdfOcr[0].options.deadlineMs - calls.pdfOcr[0].at - 70000) < 1000, 'scanned PDF OCR uses the OCR step budget');
    pdfLayer = { total: 9, text: '' };
    const longPdf = await api('POST', '/upload/ocr', { file: { buffer: PDF, originalname: 'long.pdf' } });
    assert.equal(longPdf.statusCode, 413);
    assert.match(longPdf.body.error, /9 pages/);

    console.log('proforma-upload-smoke: all checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
